/**
 * A fake Discord REST + Gateway server for the E2E harness.
 *
 * It is deliberately small: the endpoints the runtime calls, a real WebSocket handshake with
 * HELLO/READY/heartbeat, and records of everything the daemon attempted. No network, no real bot.
 */
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

export async function startFakeDiscord() {
  const bots = new Map(); // token -> record
  const labelByToken = new Map();
  const sockets = new Set();
  let sequence = 0;
  let nextId = 1000;

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      const auth = String(request.headers.authorization ?? "");
      const token = auth.startsWith("Bot ") ? auth.slice(4) : "";
      const entry = bots.get(token);

      function send(status, payload) {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(payload === undefined ? "" : JSON.stringify(payload));
      }
      function notFound() {
        send(404, { message: "Not Found", code: 10000 });
      }
      if (!entry) return send(401, { message: "401: Unauthorized", code: 0 });

      const path = url.pathname.replace(/^\/api\/v10/, "");
      const parts = path.split("/").filter(Boolean);
      const method = request.method ?? "GET";

      // users
      if (parts[0] === "users" && parts[1] === "@me" && parts.length === 2 && method === "GET") {
        return send(200, entry.user);
      }
      if (parts[0] === "users" && parts[1] === "@me" && parts[2] === "guilds" && method === "GET") {
        return send(200, entry.guilds);
      }
      if (parts[0] === "users" && parts[1] === "@me" && parts[2] === "channels" && method === "POST") {
        const userId = String(body.recipient_id ?? "");
        const channelId = "dm-" + userId;
        entry.dmChannels.set(userId, channelId);
        return send(200, { id: channelId, type: 1, recipients: [{ id: userId, username: "user-" + userId }] });
      }
      if (parts[0] === "users" && parts[1] && method === "GET") {
        const id = parts[1];
        if (id === entry.user.id) return send(200, entry.user);
        return send(200, { id, username: "user-" + id, bot: false });
      }

      // oauth application
      if (parts[0] === "oauth2" && parts[1] === "applications" && parts[2] === "@me" && method === "GET") {
        return send(200, { id: entry.applicationId, name: "dura-test", bot: entry.user });
      }

      // guilds
      if (parts[0] === "guilds" && parts[1] && parts.length === 2 && method === "GET") {
        return send(200, entry.guild);
      }
      if (parts[0] === "guilds" && parts[1] && parts[2] === "roles" && method === "GET") {
        return send(200, entry.roles);
      }
      if (parts[0] === "guilds" && parts[1] && parts[2] === "threads" && parts[3] === "active" && method === "GET") {
        return send(200, { threads: entry.threads.filter((thread) => thread.guild_id === parts[1]) });
      }
      if (parts[0] === "guilds" && parts[1] && parts[2] === "members" && parts[3]) {
        const userId = parts[3];
        if (method === "GET") {
          return send(200, {
            user: userId === entry.user.id ? entry.user : { id: userId, username: "user-" + userId, bot: false },
            roles: userId === entry.user.id ? ["role-bot"] : [],
          });
        }
        if (method === "PATCH") {
          entry.moderation.push({ action: "timeout", guildId: parts[1], userId, body });
          return send(200, { user: { id: userId, username: "user-" + userId }, roles: [], communication_disabled_until: body.communication_disabled_until ?? null });
        }
        if (method === "DELETE") {
          entry.moderation.push({ action: "kick", guildId: parts[1], userId, reason: request.headers["x-audit-log-reason"] ?? "" });
          response.writeHead(204).end();
          return;
        }
      }
      if (parts[0] === "guilds" && parts[1] && parts[2] === "bans" && parts[3]) {
        const userId = parts[3];
        if (method === "PUT") {
          entry.moderation.push({ action: "ban", guildId: parts[1], userId, body, reason: request.headers["x-audit-log-reason"] ?? "" });
          response.writeHead(204).end();
          return;
        }
        if (method === "DELETE") {
          entry.moderation.push({ action: "unban", guildId: parts[1], userId });
          response.writeHead(204).end();
          return;
        }
      }

      // channels
      if (parts[0] === "channels" && parts[1] && parts.length === 2 && method === "GET") {
        if (parts[1].startsWith("dm-")) return send(200, { id: parts[1], type: 1 });
        const thread = entry.threads.find((item) => item.id === parts[1]);
        if (thread) return send(200, thread);
        return send(200, { id: parts[1], type: 0, guild_id: entry.guild.id, name: "general" });
      }
      if (parts[0] === "channels" && parts[1] && parts[2] === "typing" && method === "POST") {
        return send(204);
      }
      if (parts[0] === "channels" && parts[1] && parts[2] === "messages" && parts.length === 3 && method === "POST") {
        const id = "m" + nextId++;
        const message = {
          id,
          channel_id: parts[1],
          guild_id: entry.guild.id,
          author: entry.user,
          content: String(body.content ?? ""),
          timestamp: new Date().toISOString(),
          edited_timestamp: null,
          type: 0,
          attachments: [],
          mentions: [],
        };
        entry.sent.push({ messageId: id, channelId: parts[1], content: message.content, components: body.components ?? [], files: Array.isArray(body.attachments) ? body.attachments.length : 0, at: Date.now() });
        return send(200, message);
      }
      if (parts[0] === "channels" && parts[1] && parts[2] === "messages" && parts[3] && method === "PATCH") {
        entry.edits.push({ channelId: parts[1], messageId: parts[3], content: String(body.content ?? ""), components: body.components ?? [], at: Date.now() });
        return send(200, { id: parts[3], channel_id: parts[1], content: String(body.content ?? ""), author: entry.user, type: 0, attachments: [], timestamp: new Date().toISOString() });
      }
      if (parts[0] === "channels" && parts[1] && parts[2] === "messages" && parts[3] && method === "DELETE") {
        entry.deleted.push({ channelId: parts[1], messageId: parts[3] });
        response.writeHead(204).end();
        return;
      }
      if (parts[0] === "channels" && parts[1] && parts[2] === "threads" && parts.length === 3 && method === "POST") {
        const id = "t" + nextId++;
        const thread = { id, type: 11, guild_id: entry.guild.id, parent_id: parts[1], name: String(body.name ?? "thread"), thread_metadata: { archived: false } };
        entry.threads.push(thread);
        return send(200, thread);
      }
      if (parts[0] === "channels" && parts[1] && parts[2] === "messages" && parts[4] === "threads" && method === "POST") {
        const id = "t" + nextId++;
        const thread = { id, type: 11, guild_id: entry.guild.id, parent_id: parts[1], name: String(body.name ?? "thread"), thread_metadata: { archived: false } };
        entry.threads.push(thread);
        return send(200, thread);
      }
      if (parts[0] === "channels" && parts[1] && parts[2] === "thread-members" && parts[3] === "@me" && method === "PUT") {
        response.writeHead(204).end();
        return;
      }
      if (parts[0] === "channels" && parts[1] && parts.length === 2 && method === "PATCH") {
        const thread = entry.threads.find((item) => item.id === parts[1]);
        if (thread) {
          Object.assign(thread, body);
          if (body.archived !== undefined) thread.thread_metadata = { ...(thread.thread_metadata ?? {}), archived: Boolean(body.archived) };
          return send(200, thread);
        }
        return send(200, { id: parts[1], ...body });
      }

      // application commands
      if (parts[0] === "applications" && parts[1] && parts[2] === "commands" && method === "PUT") {
        entry.commands = Array.isArray(body) ? body : [];
        entry.commandSets.push({ at: Date.now(), count: entry.commands.length });
        return send(200, entry.commands);
      }
      if (parts[0] === "applications" && parts[1] && parts[2] === "commands" && method === "GET") {
        return send(200, entry.commands);
      }

      // interaction callback + webhook follow-ups
      if (parts[0] === "interactions" && parts[1] && parts[3] === "callback" && method === "POST") {
        entry.callbacks.push({ interactionId: parts[1], token: parts[2], data: body });
        response.writeHead(204).end();
        return;
      }
      if (parts[0] === "webhooks" && method === "PATCH") {
        entry.edits.push({ channelId: "webhook", messageId: "@original", content: String(body.content ?? ""), components: body.components ?? [], at: Date.now() });
        return send(200, { id: "webhook", channel_id: "webhook", content: String(body.content ?? ""), author: entry.user, type: 0, attachments: [], timestamp: new Date().toISOString() });
      }
      if (parts[0] === "webhooks" && method === "POST") {
        return send(200, { id: "wh" + nextId++, channel_id: "webhook", content: String(body.content ?? ""), author: entry.user, type: 0, attachments: [], timestamp: new Date().toISOString() });
      }

      notFound();
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws) => {
    sockets.add(ws);
    const state = { entry: undefined, identified: false, seq: 0 };
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 500 } }));
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (raw) => {
      let payload;
      try {
        payload = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (payload.op === 2) {
        const token = payload.d?.token;
        const entry = bots.get(token);
        if (!entry) {
          ws.close(4004, "bad token");
          return;
        }
        state.entry = entry;
        state.identified = true;
        entry.identifyCount += 1;
        entry.socket = ws;
        ws.send(
          JSON.stringify({
            op: 0,
            s: ++state.seq,
            t: "READY",
            d: {
              v: 10,
              user: entry.user,
              session_id: "session-" + entry.label,
              resume_gateway_url: gatewayUrl,
              application: { id: entry.applicationId },
              guilds: entry.guilds,
            },
          }),
        );
        return;
      }
      if (payload.op === 6) {
        const token = payload.d?.token;
        const entry = bots.get(token);
        if (entry) {
          state.entry = entry;
          entry.resumeCount += 1;
          entry.socket = ws;
          ws.send(JSON.stringify({ op: 0, s: ++state.seq, t: "RESUMED", d: {} }));
        }
        return;
      }
      if (payload.op === 1) {
        ws.send(JSON.stringify({ op: 11 }));
        return;
      }
    });
  });

  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = "http://127.0.0.1:" + port + "/api/v10";
  const gatewayUrl = "ws://127.0.0.1:" + port;

  return {
    base,
    gatewayUrl,
    addBot({ label, username = "dura-bot", id = "9001", token, applicationId = "app-" + label, guild = { id: "g1", name: "Test Guild", owner_id: "guild-owner" } }) {
      const user = { id, username, bot: true };
      const record = {
        label,
        token,
        applicationId,
        user,
        guild,
        guilds: [guild],
        roles: [
          { id: guild.id, name: "@everyone", position: 0 },
          { id: "role-bot", name: "Bot", position: 10, managed: true },
        ],
        sent: [],
        edits: [],
        deleted: [],
        threads: [],
        moderation: [],
        commands: [],
        commandSets: [],
        callbacks: [],
        dmChannels: new Map(),
        identifyCount: 0,
        resumeCount: 0,
        socket: undefined,
      };
      bots.set(token, record);
      labelByToken.set(label, token);
      return record;
    },
    inject(label, type, data) {
      const entry = botFor(label);
      if (!entry.socket || entry.socket.readyState !== 1) throw new Error("gateway is not connected for " + label);
      entry.socket.send(JSON.stringify({ op: 0, s: ++sequence, t: type, d: data }));
    },
    closeWith(label, code) {
      const entry = botFor(label);
      entry.socket?.close(code, "test close");
    },
    sent(label) {
      return botFor(label).sent;
    },
    edits(label) {
      return botFor(label).edits;
    },
    deleted(label) {
      return botFor(label).deleted;
    },
    threads(label) {
      return botFor(label).threads;
    },
    moderation(label) {
      return botFor(label).moderation;
    },
    commands(label) {
      return botFor(label).commands;
    },
    callbacks(label) {
      return botFor(label).callbacks;
    },
    identifyCount(label) {
      return botFor(label).identifyCount;
    },
    clear(label) {
      const entry = botFor(label);
      entry.sent.length = 0;
      entry.edits.length = 0;
      entry.deleted.length = 0;
      entry.threads.length = 0;
      entry.moderation.length = 0;
      entry.callbacks.length = 0;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      for (const entry of bots.values()) entry.socket?.terminate();
      await new Promise((done) => wss.close(() => done()));
      await new Promise((done) => server.close(() => done()));
    },
  };

  function botFor(label) {
    const token = labelByToken.get(label);
    const entry = token ? bots.get(token) : undefined;
    if (!entry) throw new Error("unknown fake Discord bot " + label);
    return entry;
  }
}
