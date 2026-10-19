#!/usr/bin/env node
/**
 * E2E harness: boots a throwaway server (its own data dir, its own port, its own token) and returns
 * helpers for driving it over HTTP and WebSocket. Every scenario gets a fresh server, so nothing leaks
 * between scenarios.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";

const ROOT = resolve(import.meta.dirname, "../..");

/** Start a server. `{ real: true }` keeps the real providers (used by the optional real-model smoke). */
export async function startServer(options = {}) {
  // A scenario may hand in an existing data dir to test a restart; otherwise it gets a fresh one.
  const dataDir = options.dataDir ?? (await mkdtemp(resolve(tmpdir(), "durable-e2e-")));
  const env = {
    ...process.env,
    PI_DATA_DIR: dataDir,
    PI_SERVER_PORT: "0",
    // Agent scratch space is ~/tmp by default; inside a test it must never touch the real home.
    PI_AGENT_TMP_DIR: resolve(dataDir, "tmp"),
    PI_E2E: options.real === true ? "0" : "1",
    // A scenario can override one setting to exercise a branch that depends on the machine.
    ...(options.env ?? {}),
  };
  const child = spawn(process.execPath, ["packages/server/src/index.ts"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  const ready = new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error("server did not start within 25s:\n" + log)), 25_000);
    const watch = (stream) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        log += chunk;
        const match = log.match(/PI_SERVER_READY (\{[^\n]*\})/);
        if (match) {
          clearTimeout(timer);
          try {
            done(JSON.parse(match[1]));
          } catch (error) {
            fail(new Error("unreadable PI_SERVER_READY line: " + match[1] + " (" + String(error) + ")"));
          }
        }
      });
    };
    watch(child.stdout);
    watch(child.stderr);
    child.on("exit", (code) => {
      clearTimeout(timer);
      fail(new Error("server exited with " + code + "\n" + log));
    });
  });

  const { port, token } = await ready;
  const base = "http://127.0.0.1:" + port;

  const api = async (path, init = {}) => {
    // Only claim a JSON body when there is one: Fastify answers 400 to an empty body that is
    // announced as application/json, which would make DELETE requests look broken.
    const headers = { "x-pi-token": token, ...(init.headers ?? {}) };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    let response;
    try {
      response = await fetch(base + path, { ...init, headers });
    } catch (error) {
      // A connection-level failure has no response to inspect. Name the path and the cause, or the
      // scenario only sees the bare "fetch failed" and cannot tell which call died.
      const cause = error && typeof error === "object" ? error.cause : undefined;
      throw new Error(
        "fetch " + path + " failed: " + (cause?.code ?? cause?.message ?? "") + " " + String(error.message),
      );
    }
    const text = await response.text();
    let body = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, body };
  };

  const stop = async (stopOptions = {}) => {
    child.kill("SIGTERM");
    await new Promise((done) => setTimeout(done, 300));
    child.kill("SIGKILL");
    // keepData lets a scenario restart on the same data dir and assert what survived.
    if (stopOptions.keepData !== true) await rm(dataDir, { recursive: true, force: true });
  };

  return {
    base,
    token,
    dataDir,
    log: () => log,
    api,
    stop,
    /** Replace the scripted answers the faux provider will hand out, in order. */
    script: (steps) => api("/api/e2e/script", { method: "POST", body: JSON.stringify({ steps }) }),
    state: () => api("/api/e2e/state"),
    /** Post one message, attachments and all. */
    send: (sessionId, message) =>
      api("/api/sessions/" + sessionId + "/messages", {
        method: "POST",
        body: JSON.stringify(message),
      }),
    /**
     * Fetch one file of a user message the way the browser does: the token in the query, because an `<img>`
     * tag cannot send a header. Returns the bytes, so a test can assert on the content and its length.
     */
    attachment: async (sessionId, entryId, index) => {
      const response = await fetch(
        base + "/api/sessions/" + sessionId + "/attachments/" + entryId + "/" + index + "?token=" + token,
      );
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        cacheControl: response.headers.get("cache-control"),
        bytes: Buffer.from(await response.arrayBuffer()),
      };
    },
    /**
     * Read the server's own SQLite directly. The only way to prove what is *not* stored: an attachment's
     * bytes must be in the entry, and nowhere else.
     */
    query: (sql, ...params) => {
      const db = new DatabaseSync(resolve(dataDir, "app.sqlite"), { readOnly: true });
      try {
        return db.prepare(sql).all(...params);
      } finally {
        db.close();
      }
    },
    /** Poll a thread's transcript until an entry matches the predicate. */
    waitForEntry: async (sessionId, predicate, timeoutMs = 20_000) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const { body } = await api("/api/sessions/" + sessionId + "/messages");
        const hit = (body?.entries ?? []).find(predicate);
        if (hit) return hit;
        await new Promise((done) => setTimeout(done, 150));
      }
      const { body } = await api("/api/sessions/" + sessionId + "/messages");
      throw new Error(
        "no matching entry within " +
          timeoutMs +
          "ms; saw: " +
          (body?.entries ?? []).map((entry) => entry.role + ":" + entry.text.slice(0, 40)).join(" | "),
      );
    },
    /** Attach to one conversation's WS stream; returns { frames, close }. */
    ws: (conversationId) => {
      const frames = [];
      const socket = new WebSocket(base.replace("http", "ws") + "/api/ws?conversation=" + conversationId + "&token=" + token);
      const ready = new Promise((done, fail) => {
        socket.on("open", done);
        socket.on("error", fail);
      });
      socket.on("message", (raw) => {
        try {
          frames.push(JSON.parse(String(raw)));
        } catch {
          /* ignore malformed frames */
        }
      });
      return {
        frames,
        ready,
        close: () => socket.close(),
        /** Wait until a frame matching the predicate arrives. */
        waitFor: async (predicate, timeoutMs = 20_000) => {
          const started = Date.now();
          while (Date.now() - started < timeoutMs) {
            const hit = frames.find(predicate);
            if (hit) return hit;
            await new Promise((done) => setTimeout(done, 50));
          }
          throw new Error("no matching frame within " + timeoutMs + "ms; saw: " + frames.map((f) => f.type).join(","));
        },
      };
    },
  };
}
