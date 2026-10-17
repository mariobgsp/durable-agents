#!/usr/bin/env node
/**
 * Debug tool: attach to one session's stream, optionally post a message, print arriving frames.
 * Usage: node scripts/ws-probe.mjs <sessionId> ["message text"]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";

const root = resolve(import.meta.dirname, "..");
const token = readFileSync(resolve(root, "data/token"), "utf8").trim();
const sessionId = process.argv[2];
const text = process.argv[3];
if (!sessionId) {
  console.error("pakai: node scripts/ws-probe.mjs <sessionId> [teks]");
  process.exit(1);
}

const base = process.env.PI_BASE_URL ?? "http://127.0.0.1:8787";
const wsUrl = base.replace("http", "ws") + "/api/ws?conversation=" + sessionId + "&token=" + token;
const socket = new WebSocket(wsUrl);
let deltas = 0;

socket.on("message", (raw) => {
  let frame;
  try {
    frame = JSON.parse(String(raw));
  } catch {
    console.warn("frame is not JSON, skipped");
    return;
  }
  if (frame.type === "delta") {
    deltas += 1;
    if (deltas === 1) console.log("delta: started…");
    return;
  }
  const detail =
    frame.text ?? frame.entry?.text ?? frame.message ?? (frame.entries ? frame.entries.length + " entri" : "");
  console.log("frame:", frame.type, String(detail).slice(0, 90));
});

socket.on("open", async () => {
  console.log("connected to session", sessionId);
  if (text) {
    const response = await fetch(base + "/api/sessions/" + sessionId + "/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-pi-token": token },
      body: JSON.stringify({ text }),
    });
    console.log("post message:", response.status);
    setTimeout(() => {
      console.log("total frame delta:", deltas);
      process.exit(0);
    }, Number(process.env.PI_PROBE_MS ?? 30000));
  }
});

socket.on("error", (error) => {
  console.error("socket error:", String(error));
  process.exit(1);
});
