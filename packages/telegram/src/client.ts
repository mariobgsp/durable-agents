import type { BotCommand, CommandScope, TgResponse, TgUpdate, TgMe, TgMessage, TgChat, TgChatMember } from "./types.ts";

/**
 * A small Bot API client over fetch. One instance per bot token. It owns the two behaviours that
 * matter: a global call pace (Telegram allows roughly 30 calls per second) and retry policy (429
 * honours retry_after, 5xx backs off, 401/404 are terminal and named).
 *
 * No dependency: the surface is deliberately the dozen methods this app uses.
 */

/**
 * The words of an HTML message, for the retry that has to deliver it without markup.
 *
 * Deliberately dumb: strip tags, decode the entities this codebase emits. Anything fancier would need a
 * parser to be correct, and this is a last-resort path where readable text beats accurate formatting.
 */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export class TelegramError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;
  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.name = "TelegramError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export type InlineKeyboard = { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] };

export type SendOptions = {
  replyTo?: number;
  keyboard?: InlineKeyboard;
  disablePreview?: boolean;
  threadId?: number;
};

export type ClientOptions = {
  token: string;
  apiBase?: string;
  label?: string;
  /** Called for every retry/failure worth a log line. */
  report?: (level: "warn" | "error", message: string, fields?: Record<string, unknown>) => void;
};

const EDITABLE = new Set([400, 403, 404]);

export class BotApi {
  readonly label: string;
  private readonly token: string;
  private readonly base: string;
  private readonly report: ClientOptions["report"];
  private nextSlot = 0;
  private readonly spacingMs = 40;

  constructor(options: ClientOptions) {
    this.token = options.token;
    this.base = (options.apiBase ?? "https://api.telegram.org").replace(/\/$/, "");
    this.label = options.label ?? "bot";
    this.report = options.report;
  }

  private async pace(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.spacingMs;
    if (slot > now) await new Promise((done) => setTimeout(done, slot - now));
  }

  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
    signal?: AbortSignal,
    attempts = 4,
  ): Promise<T> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await this.pace();
      let response: Response;
      try {
        response = await fetch(this.base + "/bot" + this.token + "/" + method, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // An aborted request is an intentional shutdown, not a network failure: no retry, no warn.
        const aborted =
          signal?.aborted === true ||
          (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError");
        if (aborted) throw new TelegramError(0, "aborted", method + " aborted");
        if (attempt === attempts - 1) throw new TelegramError(0, "network", method + " failed: " + String(error));
        this.report?.("warn", "telegram network error", { bot: this.label, method, attempt: attempt + 1 });
        await new Promise((done) => setTimeout(done, 500 * (attempt + 1)));
        continue;
      }
      const payload = (await response.json().catch(() => ({}))) as TgResponse<T>;
      if (payload.ok) return payload.result as T;
      const retryAfter = payload.parameters?.retry_after;
      if (response.status === 429 && retryAfter !== undefined && attempt < attempts - 1) {
        this.report?.("warn", "telegram rate limited", { bot: this.label, method, retryAfter });
        await new Promise((done) => setTimeout(done, (retryAfter + 1) * 1000));
        continue;
      }
      if (response.status >= 500 && attempt < attempts - 1) {
        this.report?.("warn", "telegram server error", { bot: this.label, method, status: response.status });
        await new Promise((done) => setTimeout(done, 700 * (attempt + 1)));
        continue;
      }
      throw new TelegramError(
        response.status,
        payload.error_code === 401 ? "unauthorized" : payload.error_code === 409 ? "conflict" : "api",
        method + ": " + (payload.description ?? response.statusText),
        retryAfter,
      );
    }
    throw new TelegramError(0, "retries", method + ": gave up after retries");
  }

  async getMe(): Promise<TgMe> {
    return this.call<TgMe>("getMe");
  }

  async getUpdates(offset: number, timeoutSeconds = 20, signal?: AbortSignal): Promise<TgUpdate[]> {
    // One attempt: a stalled long-poll belongs to the poll loop, which backs off and reconnects.
    // Retrying it four times inside the client makes a dead connection look alive for minutes.
    const result = await this.call<TgUpdate[]>(
      "getUpdates",
      {
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ["message", "callback_query", "my_chat_member"],
      },
      (timeoutSeconds + 10) * 1000,
      signal,
      1,
    );
    if (signal?.aborted) return [];
    return result;
  }

  async sendMessage(chatId: number | string, html: string, options: SendOptions = {}): Promise<TgMessage> {
    return this.deliver<TgMessage>("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: options.disablePreview ?? true,
      ...(options.replyTo ? { reply_to_message_id: options.replyTo, allow_sending_without_reply: true } : {}),
      ...(options.threadId ? { message_thread_id: options.threadId } : {}),
      ...(options.keyboard ? { reply_markup: options.keyboard } : {}),
    });
  }

  /**
   * Send, and if Telegram rejects the HTML, send the same text as plain text instead.
   *
   * One malformed tag anywhere in a message — `<agent-id>`, `<level>`, a model quoting markup — used to lose
   * the whole message with nothing but a log line. The message is worth more than its formatting, so the
   * retry strips the markup and delivers the words.
   */
  private async deliver<T>(method: string, params: Record<string, unknown>): Promise<T> {
    try {
      return await this.call<T>(method, params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/can't parse entities|unsupported start tag/i.test(message)) throw error;
      const { parse_mode: _drop, ...rest } = params;
      this.report?.("warn", "telegram entity fallback", { bot: this.label, method });
      return this.call<T>(method, { ...rest, text: plainText(String(rest.text ?? "")) });
    }
  }

  /**
   * Telegram Rich Messages: one InputRichMessage object (markdown, html or blocks) sent as rich_message.
   * Callers must fall back to sendMessage(parse_mode HTML) when the method is not available.
   */
  async sendRichMessage(
    chatId: number | string,
    rich: { markdown?: string; html?: string },
    options: { threadId?: number; replyTo?: number } = {},
  ): Promise<TgMessage> {
    return this.call<TgMessage>("sendRichMessage", {
      chat_id: chatId,
      rich_message: rich,
      ...(options.threadId ? { message_thread_id: options.threadId } : {}),
      ...(options.replyTo
        ? { reply_parameters: { message_id: options.replyTo, allow_sending_without_reply: true } }
        : {}),
    });
  }

  async editMessage(chatId: number | string, messageId: number, html: string, keyboard?: InlineKeyboard): Promise<TgMessage | true> {
    return this.deliver<TgMessage | true>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }

  async deleteMessage(chatId: number | string, messageId: number): Promise<boolean> {
    return this.call<boolean>("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  async answerCallback(id: string, text?: string): Promise<boolean> {
    return this.call<boolean>("answerCallbackQuery", {
      callback_query_id: id,
      ...(text ? { text: text.slice(0, 190) } : {}),
    });
  }

  async sendChatAction(chatId: number | string, action = "typing"): Promise<boolean> {
    return this.call<boolean>("sendChatAction", { chat_id: chatId, action }, 10_000);
  }

  async setMyCommands(commands: BotCommand[], scope?: CommandScope, languageCode?: string): Promise<boolean> {
    return this.call<boolean>("setMyCommands", {
      commands: commands.slice(0, 100),
      ...(scope ? { scope } : {}),
      ...(languageCode ? { language_code: languageCode } : {}),
    });
  }

  async deleteMyCommands(scope?: CommandScope, languageCode?: string): Promise<boolean> {
    return this.call<boolean>("deleteMyCommands", {
      ...(scope ? { scope } : {}),
      ...(languageCode ? { language_code: languageCode } : {}),
    });
  }

  async getMyCommands(scope?: CommandScope, languageCode?: string): Promise<BotCommand[]> {
    return this.call<BotCommand[]>("getMyCommands", {
      ...(scope ? { scope } : {}),
      ...(languageCode ? { language_code: languageCode } : {}),
    });
  }

  /** Remove any inherited web-app menu button; the command list is the menu. */
  async setCommandsMenuButton(): Promise<boolean> {
    return this.call<boolean>("setChatMenuButton", { menu_button: { type: "commands" } });
  }

  async setDescription(text: string): Promise<boolean> {
    return this.call<boolean>("setMyDescription", { description: text.slice(0, 512) });
  }

  async setShortDescription(text: string): Promise<boolean> {
    return this.call<boolean>("setMyShortDescription", { short_description: text.slice(0, 120) });
  }

  async getFile(fileId: string): Promise<{ file_id: string; file_path?: string; file_size?: number }> {
    return this.call("getFile", { file_id: fileId });
  }

  async downloadFile(filePath: string, limitBytes = 20 * 1024 * 1024): Promise<Uint8Array> {
    const response = await fetch(this.base + "/file/bot" + this.token + "/" + filePath, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new TelegramError(response.status, "download", "file download failed: " + response.status);
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > limitBytes) throw new TelegramError(0, "too_large", "file is larger than the limit");
    return buffer;
  }

  async sendDocument(chatId: number | string, name: string, mimeType: string, bytes: Uint8Array, caption?: string, threadId?: number): Promise<TgMessage> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    const part = new Uint8Array(bytes).slice().buffer as ArrayBuffer;
    form.append("document", new Blob([part], { type: mimeType }), name);
    if (caption) form.append("caption", caption.slice(0, 1000));
    if (threadId) form.append("message_thread_id", String(threadId));
    const response = await fetch(this.base + "/bot" + this.token + "/sendDocument", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    const payload = (await response.json().catch(() => ({}))) as TgResponse<TgMessage>;
    if (!payload.ok) throw new TelegramError(response.status, "api", "sendDocument: " + (payload.description ?? "failed"));
    return payload.result as TgMessage;
  }

  async getChat(chatId: number | string): Promise<TgChat> {
    return this.call<TgChat>("getChat", { chat_id: chatId });
  }

  async getChatMember(chatId: number | string, userId: number | string): Promise<TgChatMember> {
    return this.call<TgChatMember>("getChatMember", { chat_id: chatId, user_id: userId });
  }

  async createInviteLink(chatId: number | string, name = "dura", memberLimit = 1): Promise<string> {
    const result = await this.call<{ invite_link: string }>("createChatInviteLink", {
      chat_id: chatId,
      name: name.slice(0, 32),
      member_limit: memberLimit,
      expire_date: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    });
    return result.invite_link;
  }

  /** True when the error means "this edit cannot land" (message gone, not modified, too old). */
  static isEditableFailure(error: unknown): boolean {
    return error instanceof TelegramError && EDITABLE.has(error.status);
  }

}

export function chunkHtml(text: string, limit = 4096): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
