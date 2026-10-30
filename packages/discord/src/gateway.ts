import type { GatewayPayload, ReadyData } from "./types.ts";

const GATEWAY_VERSION = "10";
const DEFAULT_GATEWAY = "wss://gateway.discord.gg";
const GUILDS = 1 << 0;
const GUILD_MESSAGES = 1 << 9;
const DIRECT_MESSAGES = 1 << 12;
const MESSAGE_CONTENT = 1 << 15;

/** Message content intent is privileged; the runtime explains the portal step when Discord refuses it. */
export const DISCORD_INTENTS = GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT;

export type GatewayEvent = {
  type: string;
  data: unknown;
  sequence: number | null;
};

export type GatewayOptions = {
  token: string;
  gatewayUrl?: string;
  intents?: number;
  onEvent: (event: GatewayEvent) => void | Promise<void>;
  onReady?: (data: ReadyData) => void | Promise<void>;
  onFatal?: (message: string) => void | Promise<void>;
  onHealth?: (health: { ok: boolean; state: "connecting" | "ready" | "stopped"; error?: string }) => void | Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function urlOf(base: string): string {
  const clean = base.replace(/\/+$/, "");
  return clean + "/?v=" + GATEWAY_VERSION + "&encoding=json";
}

/**
 * One Discord Gateway v10 connection.
 *
 * The object owns the socket, the heartbeat and the resume state for one bot. It reconnects with
 * jittered exponential backoff; only 4004 (bad token) and 4014 (disallowed intents) are terminal.
 */
export class DiscordGateway {
  private readonly options: GatewayOptions;
  private socket: WebSocket | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private heartbeatInterval = 0;
  private lastSeq: number | null = null;
  private sessionId: string | undefined;
  private resumeUrl: string | undefined;
  private awaitingAck = false;
  private stopped = false;
  private ready = false;
  private attempts = 0;
  private connectPromise: Promise<void> | undefined;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: Error) => void) | undefined;

  constructor(options: GatewayOptions) {
    this.options = options;
  }

  get session(): string | undefined {
    return this.sessionId;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Start the connection loop. Resolves on READY/RESUMED, rejects on a fatal close or timeout. */
  start(timeoutMs = 20_000): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      setTimeout(() => {
        if (!this.ready) reject(new Error("Discord gateway did not become ready within " + timeoutMs + "ms"));
      }, timeoutMs).unref?.();
    });
    this.connect();
    return this.connectPromise;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    this.clearHeartbeat();
    try {
      this.socket?.close(1000, "dura stop");
    } catch {
      /* already closed */
    }
    this.socket = undefined;
    await this.options.onHealth?.({ ok: false, state: "stopped" });
  }

  private async health(ok: boolean, state: "connecting" | "ready" | "stopped", error?: string): Promise<void> {
    await Promise.resolve(this.options.onHealth?.({ ok, state, ...(error ? { error } : {}) })).catch(() => undefined);
  }

  private async fatal(message: string): Promise<void> {
    this.stopped = true;
    this.clearHeartbeat();
    await this.health(false, "stopped", message);
    await Promise.resolve(this.options.onFatal?.(message)).catch(() => undefined);
    this.rejectReady?.(new Error(message));
  }

  private connect(): void {
    if (this.stopped) return;
    void this.health(false, "connecting");
    const url = urlOf(this.resumeUrl ?? this.options.gatewayUrl ?? DEFAULT_GATEWAY);
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      void this.scheduleReconnect("cannot open gateway: " + (error instanceof Error ? error.message : String(error)));
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.attempts = 0;
    });
    socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
      let payload: GatewayPayload;
      try {
        payload = JSON.parse(raw) as GatewayPayload;
      } catch {
        return;
      }
      void this.handle(payload);
    });
    socket.addEventListener("error", () => {
      // The close event carries the code and the reason; this is only a liveness hint.
    });
    socket.addEventListener("close", (event) => {
      this.clearHeartbeat();
      this.ready = false;
      if (this.stopped) return;
      const code = event.code;
      if (code === 4004) return void this.fatal("Discord rejected the bot token (close 4004). Check the token in secrets/discord.json.");
      if (code === 4014) {
        return void this.fatal(
          "Discord refused the requested intents (close 4014). Enable Message Content Intent in the Discord Developer Portal, then restart.",
        );
      }
      void this.scheduleReconnect("gateway closed with code " + code + (event.reason ? ": " + event.reason : ""));
    });
  }

  private async scheduleReconnect(reason: string): Promise<void> {
    if (this.stopped) return;
    this.attempts += 1;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(this.attempts - 1, 5)) + Math.random() * 500;
    await this.health(false, "connecting", reason);
    await sleep(delay);
    if (!this.stopped) this.connect();
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private send(op: number, d?: unknown): void {
    if (this.socket?.readyState !== 1) return;
    this.socket.send(JSON.stringify({ op, ...(d === undefined ? {} : { d }) }));
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatInterval = intervalMs;
    this.awaitingAck = false;
    const first = Math.max(50, Math.floor(intervalMs * Math.random()));
    setTimeout(() => this.beat(), first).unref?.();
    this.heartbeat = setInterval(() => this.beat(), intervalMs);
    this.heartbeat.unref?.();
  }

  private beat(): void {
    if (this.stopped) return;
    if (this.awaitingAck) {
      try {
        this.socket?.close(4000, "heartbeat timeout");
      } catch {
        /* reconnect will follow */
      }
      return;
    }
    this.awaitingAck = true;
    this.send(1, this.lastSeq);
  }

  private identify(): void {
    this.send(2, {
      token: this.options.token,
      intents: this.options.intents ?? DISCORD_INTENTS,
      properties: { os: process.platform, browser: "dura-agents", device: "dura-agents" },
    });
  }

  private resume(): void {
    if (!this.sessionId) return void this.identify();
    this.send(6, { token: this.options.token, session_id: this.sessionId, seq: this.lastSeq });
  }

  private async handle(payload: GatewayPayload): Promise<void> {
    switch (payload.op) {
      case 10: {
        const data = payload.d as { heartbeat_interval?: number } | undefined;
        this.startHeartbeat(data?.heartbeat_interval ?? 41_250);
        if (this.sessionId) this.resume();
        else this.identify();
        return;
      }
      case 11:
        this.awaitingAck = false;
        return;
      case 1:
        this.send(1, this.lastSeq);
        return;
      case 7:
        try {
          this.socket?.close(4000, "reconnect requested");
        } catch {
          /* close handler reconnects */
        }
        return;
      case 9: {
        const resumable = payload.d === true;
        if (!resumable) {
          this.sessionId = undefined;
          this.resumeUrl = undefined;
          this.lastSeq = null;
        }
        try {
          this.socket?.close(4000, "invalid session");
        } catch {
          /* close handler reconnects */
        }
        return;
      }
      case 0: {
        if (typeof payload.s === "number") this.lastSeq = payload.s;
        const type = payload.t ?? "";
        if (type === "READY") {
          const data = payload.d as ReadyData;
          this.sessionId = data.session_id;
          this.resumeUrl = data.resume_gateway_url;
          this.ready = true;
          this.attempts = 0;
          await this.health(true, "ready", data.user?.username);
          await Promise.resolve(this.options.onReady?.(data)).catch(() => undefined);
          this.resolveReady?.();
        } else if (type === "RESUMED") {
          this.ready = true;
          await this.health(true, "ready");
          this.resolveReady?.();
        }
        await Promise.resolve(this.options.onEvent({ type, data: payload.d, sequence: this.lastSeq })).catch(() => undefined);
        return;
      }
      default:
        return;
    }
  }
}
