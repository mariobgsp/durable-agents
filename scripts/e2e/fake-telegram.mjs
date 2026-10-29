/**
 * A fake Bot API. One HTTP server, several tokens, per-token update queues, and a record of every
 * message and edit the daemon attempted. This is what makes Telegram behaviour deterministic: no
 * network, no real chat, no waiting for a person.
 */
import { createServer } from "node:http";

export async function startFakeTelegram() {
  const bots = new Map(); // token -> { id, username, label, updates: [], sent: [], edits: [], documents: [], getUser: 0 }
  const tokenByLabel = new Map();
  const sockets = new Set();

  function botFor(token) {
    const entry = bots.get(token);
    if (!entry) throw new Error("unknown token " + token.slice(0, 6));
    return entry;
  }

  function nextMessageId(entry) {
    entry.nextId = (entry.nextId ?? 1000) + 1;
    return entry.nextId;
  }

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
      if (request.method === "GET" && url.pathname.startsWith("/file/")) {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(Buffer.from("file-bytes"));
        return;
      }
      if (!match) {
        response.writeHead(404).end("not found");
        return;
      }
      const [, token, method] = match;
      let entry;
      try {
        entry = botFor(token);
      } catch {
        reply(response, 401, { ok: false, error_code: 401, description: "Unauthorized" });
        return;
      }
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      switch (method) {
        case "getMe":
          reply(response, 200, { ok: true, result: { id: Number(entry.id), is_bot: true, first_name: entry.label, username: entry.username } });
          return;
        case "setMyCommands":
          entry.commandSets.push({ scope: body.scope ?? { type: "default" }, commands: body.commands ?? [], language: body.language_code ?? "" });
          reply(response, 200, { ok: true, result: true });
          return;
        case "deleteMyCommands":
          entry.commandDeletes.push({ scope: body.scope ?? { type: "default" }, language: body.language_code ?? "" });
          reply(response, 200, { ok: true, result: true });
          return;
        case "setChatMenuButton":
          entry.menuButton = body.menu_button ?? null;
          reply(response, 200, { ok: true, result: true });
          return;
        case "deleteMessage":
          entry.deleted.push({ chatId: Number(body.chat_id), messageId: Number(body.message_id) });
          reply(response, 200, { ok: true, result: true });
          return;
        case "sendRichMessage":
          // Exercise the HTML fallback: rich messages are a live-API path, not a fake one.
          reply(response, 400, { ok: false, error_code: 400, description: "Bad Request: unsupported rich message" });
          return;
        case "sendChatAction":
        case "answerCallbackQuery":
          reply(response, 200, { ok: true, result: true });
          return;
        case "getUpdates": {
          const offset = Number(body.offset ?? 0);
          const due = entry.updates.filter((update) => update.update_id >= offset);
          const finish = () => {
            if (due.length > 0) entry.updates = entry.updates.filter((update) => update.update_id < (due.at(-1)?.update_id ?? 0) + 1);
            reply(response, 200, { ok: true, result: due });
          };
          if (due.length > 0) finish();
          else setTimeout(finish, 250);
          return;
        }
        case "sendMessage": {
          const messageId = nextMessageId(entry);
          entry.sent.push({ messageId, chatId: Number(body.chat_id), text: String(body.text ?? ""), replyMarkup: body.reply_markup ?? null, threadId: body.message_thread_id ?? null, at: Date.now() });
          reply(response, 200, {
            ok: true,
            result: { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: Number(body.chat_id), type: "private" }, text: String(body.text ?? "") },
          });
          return;
        }
        case "editMessageText": {
          entry.edits.push({ chatId: Number(body.chat_id), messageId: Number(body.message_id), text: String(body.text ?? ""), replyMarkup: body.reply_markup ?? null, at: Date.now() });
          reply(response, 200, { ok: true, result: true });
          return;
        }
        case "sendDocument": {
          entry.documents.push({ chatId: Number(body.chat_id), caption: body.caption ?? null });
          reply(response, 200, { ok: true, result: { message_id: nextMessageId(entry), date: Math.floor(Date.now() / 1000), chat: { id: 0, type: "private" } } });
          return;
        }
        case "getFile":
          reply(response, 200, { ok: true, result: { file_id: body.file_id, file_path: "files/test", file_size: 10 } });
          return;
        case "getChat":
          reply(response, 200, { ok: true, result: { id: Number(body.chat_id), type: "group" } });
          return;
        case "getChatMember":
          reply(response, 200, { ok: true, result: { status: "member", user: { id: Number(body.user_id), is_bot: false } } });
          return;
        case "createChatInviteLink":
          reply(response, 200, { ok: true, result: { invite_link: "https://t.me/+fake-invite" } });
          return;
        default:
          reply(response, 200, { ok: true, result: true });
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  function reply(response, status, payload) {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  }

  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const base = "http://127.0.0.1:" + (typeof address === "object" && address ? address.port : 0);

  return {
    base,
    addBot({ label, username, id, token }) {
      const record = { id: String(id), username, label, updates: [], sent: [], edits: [], deleted: [], documents: [], commandSets: [], commandDeletes: [], menuButton: null, nextId: 1000 };
      bots.set(token, record);
      tokenByLabel.set(label, token);
      return token;
    },
    inject(label, update) {
      const token = tokenByLabel.get(label);
      const entry = botFor(token);
      entry.updates.push(update);
    },
    sent(label) {
      return botFor(tokenByLabel.get(label)).sent;
    },
    edits(label) {
      return botFor(tokenByLabel.get(label)).edits;
    },
    documents(label) {
      return botFor(tokenByLabel.get(label)).documents;
    },
    deletedMessages(label) {
      return botFor(tokenByLabel.get(label)).deleted;
    },
    commandSets(label) {
      return botFor(tokenByLabel.get(label)).commandSets;
    },
    commandDeletes(label) {
      return botFor(tokenByLabel.get(label)).commandDeletes;
    },
    menuButton(label) {
      return botFor(tokenByLabel.get(label)).menuButton;
    },
    clear(label) {
      const entry = botFor(tokenByLabel.get(label));
      entry.sent.length = 0;
      entry.edits.length = 0;
      entry.documents.length = 0;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => server.close(() => done()));
    },
  };
}
