import { connect, type Socket } from "node:net";
import { socketPath } from "../../core/src/paths.ts";

/** A daemon that is not running is a normal state, not a crash: exit 3 names it. */
export class DaemonUnavailable extends Error {
  readonly exitCode = 3;
  constructor(message = "the dura daemon is not running; start it with: dura start") {
    super(message);
    this.name = "DaemonUnavailable";
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
};

export class DaemonClient {
  private socket: Socket;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();
  private closed = false;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    const close = (): void => {
      this.closed = true;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new DaemonUnavailable("the daemon closed the connection"));
      }
      this.pending.clear();
    };
    socket.on("close", close);
    socket.on("error", close);
  }

  static async connect(path = socketPath, timeoutMs = 2000): Promise<DaemonClient> {
    const socket = connect(path);
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => {
        socket.destroy();
        fail(new DaemonUnavailable());
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        done();
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        fail(
          error.code === "ENOENT" || error.code === "ECONNREFUSED"
            ? new DaemonUnavailable()
            : new DaemonUnavailable("cannot reach the daemon socket " + path + ": " + String(error)),
        );
      });
    });
    return new DaemonClient(socket);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const raw = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!raw) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof frame.event === "string") {
        const set = this.listeners.get(frame.event);
        if (set) for (const listener of set) listener(frame.data);
        continue;
      }
      const id = String(frame.id ?? "");
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (frame.ok === true) pending.resolve(frame.result);
      else {
        const error = frame.error as { code?: string; message?: string } | undefined;
        const failure = new Error(error?.message ?? "the daemon refused the request") as Error & { code?: string };
        failure.code = error?.code;
        pending.reject(failure);
      }
    }
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new DaemonUnavailable("the daemon connection is closed"));
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("the daemon did not answer " + method + " within " + timeoutMs + "ms"));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  on<T = unknown>(event: string, listener: (data: T) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as (data: unknown) => void);
    this.listeners.set(event, set);
    return () => set.delete(listener as (data: unknown) => void);
  }

  async subscribeFleet<T = unknown>(listener: (data: T) => void): Promise<() => Promise<void>> {
    const off = this.on("fleet", listener);
    await this.request("fleet.subscribe");
    return async () => {
      off();
      await this.request("fleet.unsubscribe").catch(() => undefined);
    };
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }
}

export async function withDaemon<T>(work: (client: DaemonClient) => Promise<T>): Promise<T> {
  const client = await DaemonClient.connect();
  try {
    return await work(client);
  } finally {
    client.close();
  }
}
