import type {
  DiscordApplication,
  DiscordApplicationCommand,
  DiscordChannel,
  DiscordErrorBody,
  DiscordGuild,
  DiscordGuildMember,
  DiscordMessage,
  DiscordMessageInput,
  DiscordRole,
  DiscordUser,
  Snowflake,
} from "./types.ts";

const API_VERSION = "10";
const DEFAULT_BASE = "https://discord.com/api/v10";
const MAX_RETRIES = 3;

export class DiscordApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  readonly retryAfter: number | undefined;
  readonly fatal: boolean;
  constructor(status: number, body: DiscordErrorBody | undefined, fallback: string) {
    super("Discord API " + status + ": " + (body?.message ?? fallback));
    this.name = "DiscordApiError";
    this.status = status;
    this.code = body?.code;
    this.retryAfter = body?.retry_after;
    this.fatal = status === 401;
  }
}

type RequestOptions = {
  body?: unknown;
  form?: FormData;
  reason?: string;
  bucket?: string;
  retries?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, Math.max(0, ms)));
}

/** One connection's REST client. The token never appears in an error message or a log field. */
export class DiscordApi {
  readonly label: string;
  readonly base: string;
  private readonly token: string;
  private globalUntil = 0;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(options: { token: string; apiBase?: string; label?: string }) {
    this.token = options.token;
    this.label = options.label ?? "discord";
    const configured = (options.apiBase ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.base = configured.endsWith("/api/v" + API_VERSION) ? configured : configured + "/api/v" + API_VERSION;
  }

  private headers(extra?: Record<string, string>, hasForm = false): Record<string, string> {
    return {
      Authorization: "Bot " + this.token,
      "User-Agent": "DiscordBot (https://github.com/mariobgsp/durable-agents, 0.1.0)",
      ...(hasForm ? {} : { "Content-Type": "application/json" }),
      ...extra,
    };
  }

  /** Serialize one route (bucket) and respect the global pause; the caller releases on completion. */
  private async acquire(bucket: string): Promise<() => void> {
    const previous = this.queues.get(bucket) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(bucket, previous.then(() => done));
    await previous;
    const globalWait = this.globalUntil - Date.now();
    if (globalWait > 0) await sleep(globalWait);
    return release;
  }

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const bucket = options.bucket ?? method + " " + path.replace(/\/[0-9]+/g, "/:id");
    const release = await this.acquire(bucket);
    try {
      let attempt = 0;
      for (;;) {
        const headers = this.headers(
          {
            ...(options.reason ? { "X-Audit-Log-Reason": encodeURIComponent(options.reason) } : {}),
          },
          Boolean(options.form),
        );
        let response: Response;
        try {
          response = await fetch(this.base + path, {
            method,
            headers,
            ...(options.form ? { body: options.form } : options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
            signal: AbortSignal.timeout(30_000),
          });
        } catch (error) {
          if (attempt < MAX_RETRIES) {
            attempt += 1;
            await sleep(500 * 2 ** attempt);
            continue;
          }
          throw new Error("Discord network error: " + (error instanceof Error ? error.message : String(error)));
        }

        const remaining = Number(response.headers.get("x-ratelimit-remaining") ?? "1");
        const resetAfter = Number(response.headers.get("x-ratelimit-reset-after") ?? "0");
        if (remaining <= 0 && Number.isFinite(resetAfter)) this.globalUntil = Math.max(this.globalUntil, Date.now() + resetAfter * 1000 + 50);

        if (response.status === 204) return undefined as T;
        const text = await response.text();
        let body: unknown;
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          body = undefined;
        }

        if (response.status === 429) {
          const errorBody = body as DiscordErrorBody | undefined;
          const retry = (errorBody?.retry_after ?? resetAfter ?? 1) * 1000;
          if (attempt < MAX_RETRIES) {
            attempt += 1;
            await sleep(retry + 100 + Math.random() * 250);
            continue;
          }
          throw new DiscordApiError(429, errorBody, "rate limited");
        }
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          attempt += 1;
          await sleep(750 * 2 ** attempt);
          continue;
        }
        if (!response.ok) throw new DiscordApiError(response.status, body as DiscordErrorBody | undefined, response.statusText);
        return body as T;
      }
    } finally {
      release();
    }
  }

  async getMe(): Promise<DiscordUser> {
    return this.request("GET", "/users/@me");
  }

  async getApplication(): Promise<DiscordApplication> {
    return this.request("GET", "/oauth2/applications/@me");
  }

  async getUser(id: Snowflake): Promise<DiscordUser> {
    return this.request("GET", "/users/" + encodeURIComponent(id));
  }

  async getGuilds(): Promise<DiscordGuild[]> {
    return this.request("GET", "/users/@me/guilds");
  }

  async getGuild(id: Snowflake): Promise<DiscordGuild> {
    return this.request("GET", "/guilds/" + encodeURIComponent(id));
  }

  async getGuildRoles(id: Snowflake): Promise<DiscordRole[]> {
    return this.request("GET", "/guilds/" + encodeURIComponent(id) + "/roles", { bucket: "GET /guilds/:id/roles" });
  }

  async getChannel(id: Snowflake): Promise<DiscordChannel> {
    return this.request("GET", "/channels/" + encodeURIComponent(id));
  }

  async getGuildMember(guildId: Snowflake, userId: Snowflake): Promise<DiscordGuildMember> {
    return this.request("GET", "/guilds/" + encodeURIComponent(guildId) + "/members/" + encodeURIComponent(userId));
  }

  async createDM(userId: Snowflake): Promise<DiscordChannel> {
    return this.request("POST", "/users/@me/channels", { body: { recipient_id: userId } });
  }

  private messageBody(input: DiscordMessageInput): unknown {
    return {
      ...(input.content ? { content: input.content.slice(0, 2000) } : {}),
      ...(input.components?.length ? { components: input.components } : {}),
      ...(input.embeds?.length ? { embeds: input.embeds } : {}),
      allowed_mentions: input.allowed_mentions ?? { parse: [] },
      ...(input.message_reference ? { message_reference: input.message_reference } : {}),
    };
  }

  async sendMessage(channelId: Snowflake, input: DiscordMessageInput): Promise<DiscordMessage> {
    if (input.files?.length) {
      const form = new FormData();
      form.append("payload_json", JSON.stringify(this.messageBody(input)));
      input.files.slice(0, 10).forEach((file, index) => {
        const buffer = file.data.buffer.slice(file.data.byteOffset, file.data.byteOffset + file.data.byteLength) as ArrayBuffer;
        form.append("files[" + index + "]", new Blob([buffer], { type: file.mimeType ?? "application/octet-stream" }), file.name);
      });
      return this.request("POST", "/channels/" + encodeURIComponent(channelId) + "/messages", {
        form,
        bucket: "POST /channels/:id/messages",
      });
    }
    return this.request("POST", "/channels/" + encodeURIComponent(channelId) + "/messages", {
      body: this.messageBody(input),
      bucket: "POST /channels/:id/messages",
    });
  }

  async editMessage(channelId: Snowflake, messageId: Snowflake, input: DiscordMessageInput): Promise<DiscordMessage> {
    return this.request("PATCH", "/channels/" + encodeURIComponent(channelId) + "/messages/" + encodeURIComponent(messageId), {
      body: this.messageBody(input),
      bucket: "PATCH /channels/:id/messages/:id",
    });
  }

  async deleteMessage(channelId: Snowflake, messageId: Snowflake): Promise<void> {
    await this.request("DELETE", "/channels/" + encodeURIComponent(channelId) + "/messages/" + encodeURIComponent(messageId), {
      bucket: "DELETE /channels/:id/messages/:id",
    });
  }

  async sendTyping(channelId: Snowflake): Promise<void> {
    await this.request("POST", "/channels/" + encodeURIComponent(channelId) + "/typing", { bucket: "POST /channels/:id/typing" });
  }

  async createThread(
    channelId: Snowflake,
    input: { name: string; autoArchiveDuration?: number; type?: 11 | 12 },
  ): Promise<DiscordChannel> {
    return this.request("POST", "/channels/" + encodeURIComponent(channelId) + "/threads", {
      body: {
        name: input.name.slice(0, 100),
        auto_archive_duration: input.autoArchiveDuration ?? 1440,
        type: input.type ?? 11,
        invitable: true,
      },
      bucket: "POST /channels/:id/threads",
    });
  }

  async createThreadFromMessage(
    channelId: Snowflake,
    messageId: Snowflake,
    input: { name: string; autoArchiveDuration?: number },
  ): Promise<DiscordChannel> {
    return this.request(
      "POST",
      "/channels/" + encodeURIComponent(channelId) + "/messages/" + encodeURIComponent(messageId) + "/threads",
      {
        body: { name: input.name.slice(0, 100), auto_archive_duration: input.autoArchiveDuration ?? 1440 },
        bucket: "POST /channels/:id/messages/:id/threads",
      },
    );
  }

  async joinThread(threadId: Snowflake): Promise<void> {
    await this.request("PUT", "/channels/" + encodeURIComponent(threadId) + "/thread-members/@me", {
      bucket: "PUT /channels/:id/thread-members/@me",
    });
  }

  async editThread(
    threadId: Snowflake,
    input: { name?: string; archived?: boolean; locked?: boolean; autoArchiveDuration?: number },
  ): Promise<DiscordChannel> {
    return this.request("PATCH", "/channels/" + encodeURIComponent(threadId), {
      body: {
        ...(input.name ? { name: input.name.slice(0, 100) } : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
        ...(input.locked !== undefined ? { locked: input.locked } : {}),
        ...(input.autoArchiveDuration !== undefined ? { auto_archive_duration: input.autoArchiveDuration } : {}),
      },
      bucket: "PATCH /channels/:id",
    });
  }

  async listActiveThreads(guildId: Snowflake): Promise<DiscordChannel[]> {
    const result = await this.request<{ threads?: DiscordChannel[] }>(
      "GET",
      "/guilds/" + encodeURIComponent(guildId) + "/threads/active",
      { bucket: "GET /guilds/:id/threads/active" },
    );
    return result.threads ?? [];
  }

  async moderateMember(guildId: Snowflake, userId: Snowflake, input: { timeoutSeconds: number; reason: string }): Promise<DiscordGuildMember> {
    const until = input.timeoutSeconds > 0 ? new Date(Date.now() + input.timeoutSeconds * 1000).toISOString() : null;
    return this.request(
      "PATCH",
      "/guilds/" + encodeURIComponent(guildId) + "/members/" + encodeURIComponent(userId),
      {
        body: { communication_disabled_until: until },
        reason: input.reason,
        bucket: "PATCH /guilds/:id/members/:id",
      },
    );
  }

  async kickMember(guildId: Snowflake, userId: Snowflake, reason: string): Promise<void> {
    await this.request("DELETE", "/guilds/" + encodeURIComponent(guildId) + "/members/" + encodeURIComponent(userId), {
      reason,
      bucket: "DELETE /guilds/:id/members/:id",
    });
  }

  async banMember(guildId: Snowflake, userId: Snowflake, input: { reason: string; deleteMessageSeconds?: number }): Promise<void> {
    await this.request("PUT", "/guilds/" + encodeURIComponent(guildId) + "/bans/" + encodeURIComponent(userId), {
      body: { delete_message_seconds: Math.min(604_800, Math.max(0, input.deleteMessageSeconds ?? 0)) },
      reason: input.reason,
      bucket: "PUT /guilds/:id/bans/:id",
    });
  }

  async unbanMember(guildId: Snowflake, userId: Snowflake, reason: string): Promise<void> {
    await this.request("DELETE", "/guilds/" + encodeURIComponent(guildId) + "/bans/" + encodeURIComponent(userId), {
      reason,
      bucket: "DELETE /guilds/:id/bans/:id",
    });
  }

  async addRole(guildId: Snowflake, userId: Snowflake, roleId: Snowflake, reason?: string): Promise<void> {
    await this.request(
      "PUT",
      "/guilds/" + encodeURIComponent(guildId) + "/members/" + encodeURIComponent(userId) + "/roles/" + encodeURIComponent(roleId),
      { ...(reason ? { reason } : {}), bucket: "PUT /guilds/:id/members/:id/roles/:id" },
    );
  }

  async removeRole(guildId: Snowflake, userId: Snowflake, roleId: Snowflake, reason?: string): Promise<void> {
    await this.request(
      "DELETE",
      "/guilds/" + encodeURIComponent(guildId) + "/members/" + encodeURIComponent(userId) + "/roles/" + encodeURIComponent(roleId),
      { ...(reason ? { reason } : {}), bucket: "DELETE /guilds/:id/members/:id/roles/:id" },
    );
  }

  async registerCommands(
    applicationId: Snowflake,
    commands: DiscordApplicationCommand[],
    guildId?: Snowflake,
  ): Promise<DiscordApplicationCommand[]> {
    const path = guildId
      ? "/applications/" + encodeURIComponent(applicationId) + "/guilds/" + encodeURIComponent(guildId) + "/commands"
      : "/applications/" + encodeURIComponent(applicationId) + "/commands";
    return this.request("PUT", path, { body: commands, bucket: "PUT " + path });
  }

  async getCommands(applicationId: Snowflake, guildId?: Snowflake): Promise<DiscordApplicationCommand[]> {
    const path = guildId
      ? "/applications/" + encodeURIComponent(applicationId) + "/guilds/" + encodeURIComponent(guildId) + "/commands"
      : "/applications/" + encodeURIComponent(applicationId) + "/commands";
    return this.request("GET", path, { bucket: "GET " + path });
  }

  async interactionCallback(interactionId: Snowflake, token: string, data: unknown): Promise<void> {
    await this.request("POST", "/interactions/" + encodeURIComponent(interactionId) + "/" + encodeURIComponent(token) + "/callback", {
      body: data,
      bucket: "POST /interactions/:id/:token/callback",
    });
  }

  async editOriginalInteraction(applicationId: Snowflake, token: string, input: DiscordMessageInput): Promise<DiscordMessage> {
    return this.request(
      "PATCH",
      "/webhooks/" + encodeURIComponent(applicationId) + "/" + encodeURIComponent(token) + "/messages/@original",
      { body: this.messageBody(input), bucket: "PATCH /webhooks/:id/:token/messages/@original" },
    );
  }

  async followUpInteraction(applicationId: Snowflake, token: string, input: DiscordMessageInput): Promise<DiscordMessage> {
    return this.request(
      "POST",
      "/webhooks/" + encodeURIComponent(applicationId) + "/" + encodeURIComponent(token),
      { body: this.messageBody(input), bucket: "POST /webhooks/:id/:token" },
    );
  }
}
