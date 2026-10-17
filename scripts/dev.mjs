#!/usr/bin/env node
/**
 * One dev command: create a token, start the server, start Vite.
 * The token is written to data/token (mode 600) and injected into index.html by the Vite plugin.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dataDir = resolve(root, "data");
mkdirSync(dataDir, { recursive: true });

const tokenPath = resolve(dataDir, "token");
const token = randomBytes(32).toString("hex");
writeFileSync(tokenPath, token, { mode: 0o600 });
chmodSync(tokenPath, 0o600);

const port = process.env.PI_SERVER_PORT ?? "8787";
const children = [];
let closing = false;

function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(code);
  }, 1500).unref();
}

function start(name, scriptPath, env, cwd = root, args = []) {
  const child = spawn(process.execPath, [...args, scriptPath], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tag = "\u001b[2m[" + name + "]\u001b[0m";
  for (const stream of ["stdout", "stderr"]) {
    child[stream].setEncoding("utf8");
    let rest = "";
    child[stream].on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) console.log(tag + " " + line);
    });
  }
  child.on("exit", (code, signal) => {
    if (closing) return;
    console.error(tag + " exited (" + (signal ?? code) + ")");
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start(
  "server",
  resolve(root, "packages/server/src/index.ts"),
  {
    PI_API_TOKEN: token,
    PI_SERVER_PORT: port,
    PI_DATA_DIR: dataDir,
  },
  root,
  // --watch: the server restarts when server files change (the frontend has its own HMR).
  ["--watch"],
);
start(
  "web",
  resolve(root, "node_modules/vite/bin/vite.js"),
  { PI_SERVER_PORT: port },
  resolve(root, "packages/web"),
);

console.log("\n  Durable Agents dev → http://localhost:5173\n");
