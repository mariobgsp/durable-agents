#!/usr/bin/env node
/**
 * Screenshot the "replying" indicator.
 *
 * This cannot live in `shots.mjs`: that runs against the dev server, which uses real providers, so a
 * generation cannot be held open deterministically. Here a throwaway server runs in E2E mode with the faux
 * provider streaming at a fixed pace, which keeps one thread generating long enough to photograph both
 * states — the dots on its sidebar row while you are elsewhere, and the dots inside the chat itself.
 *
 * Build first (`npm run build`), because the server serves the built UI and injects the boot token.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync as exists } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const CHROME = process.env.PI_CHROME ?? "/usr/bin/chromium";
const ROOT = resolve(import.meta.dirname, "../../..");
const DATE = new Date().toISOString().slice(0, 10);
const OUT = resolve(ROOT, "docs/ui-review", DATE);

/** Long enough to stay in flight for many seconds at the faux provider's 12 tokens/s. */
const LONG = "Brewing this answer slowly, on purpose, so the indicator stays on screen while the shutter clicks. ".repeat(4);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function shoot(url, size, file) {
  return new Promise((done) => {
    const child = spawn(
      CHROME,
      [
        "--headless=new",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=" + size,
        "--virtual-time-budget=4000",
        "--screenshot=" + file,
        url,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("exit", (code) => done({ code, stderr: stderr.slice(-300) }));
  });
}

if (!exists(resolve(ROOT, "packages/web/dist/index.html"))) {
  console.error("packages/web/dist is missing — run `npm run build` first.");
  process.exit(1);
}

const dataDir = await mkdtemp(resolve(tmpdir(), "durable-replying-"));
const server = spawn(process.execPath, ["packages/server/src/index.ts"], {
  cwd: ROOT,
  env: { ...process.env, PI_E2E: "1", PI_DATA_DIR: dataDir, PI_SERVER_PORT: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});

let log = "";
const ready = new Promise((done, fail) => {
  const timer = setTimeout(() => fail(new Error("server did not start:\n" + log)), 25_000);
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
          fail(new Error("unreadable PI_SERVER_READY: " + match[1] + " (" + String(error) + ")"));
        }
      }
    });
  };
  watch(server.stdout);
  watch(server.stderr);
  server.on("exit", (code) => {
    clearTimeout(timer);
    fail(new Error("server exited with " + code + "\n" + log));
  });
});

let problems = [];
try {
  const { port, token } = await ready;
  const base = "http://127.0.0.1:" + port;

  const api = async (path, init = {}) => {
    const headers = { "x-pi-token": token, ...(init.headers ?? {}) };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(base + path, { ...init, headers });
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

  // An agent on the faux text model, so no credentials and no network are involved.
  await api("/api/agents", {
    method: "POST",
    body: JSON.stringify({ name: "Replying demo", provider: "e2e", modelId: "faux-text", tools: [] }),
  });
  const busy = (await api("/api/sessions", { method: "POST", body: JSON.stringify({ title: "Replying thread", agentId: "replying-demo" }) })).body;
  const other = (await api("/api/sessions", { method: "POST", body: JSON.stringify({ title: "Another thread", agentId: "replying-demo" }) })).body;

  await api("/api/e2e/script", { method: "POST", body: JSON.stringify({ steps: [{ text: LONG }, { text: LONG }] }) });
  await api("/api/sessions/" + busy.id + "/messages", { method: "POST", body: JSON.stringify({ text: "take your time" }) });

  // Wait until the server agrees it is generating, then photograph both states.
  let active = false;
  for (let attempt = 0; attempt < 40 && !active; attempt += 1) {
    const { body } = await api("/api/activity");
    active = (body.active ?? []).map(String).includes(String(busy.id));
    if (!active) await sleep(100);
  }
  if (!active) problems.push("the thread never became active, so nothing could be photographed");

  await mkdir(OUT, { recursive: true });

  // 1. Standing in another thread: the dots belong on the busy thread's sidebar row.
  const sidebarShot = resolve(OUT, "09-replying-sidebar-1440x900.png");
  const first = await shoot(base + "/#/s/" + other.id, "1440,900", sidebarShot);
  console.log((first.code === 0 && exists(sidebarShot) ? "ok   " : "FAIL ") + " " + sidebarShot.replace(ROOT + "/", ""));

  // 2. Inside the busy thread: the dots belong in the chat, and not on its sidebar row.
  const chatShot = resolve(OUT, "09-replying-chat-1440x900.png");
  const second = await shoot(base + "/#/s/" + busy.id, "1440,900", chatShot);
  console.log((second.code === 0 && exists(chatShot) ? "ok   " : "FAIL ") + " " + chatShot.replace(ROOT + "/", ""));

  // 3. Same thing at the phone tier.
  const mobileShot = resolve(OUT, "09-replying-chat-390x844.png");
  const third = await shoot(base + "/#/s/" + busy.id, "390,844", mobileShot);
  console.log((third.code === 0 && exists(mobileShot) ? "ok   " : "FAIL ") + " " + mobileShot.replace(ROOT + "/", ""));
} catch (error) {
  problems.push(String(error));
} finally {
  server.kill("SIGTERM");
  await sleep(400);
  server.kill("SIGKILL");
  await rm(dataDir, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error("\n" + problems.length + " problem(s):");
  for (const problem of problems) console.error("  - " + problem);
  process.exit(1);
}
console.log("\nreplying screenshots in " + OUT.replace(ROOT + "/", ""));
