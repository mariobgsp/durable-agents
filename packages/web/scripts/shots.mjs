#!/usr/bin/env node
/**
 * Screenshot the main routes with the system Chromium (no browser download).
 * Start the dev server first, then: npm run shots
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const CHROME = process.env.PI_CHROME ?? "/usr/bin/chromium";
const BASE = process.env.PI_BASE_URL ?? "http://localhost:5173";
const ROOT = resolve(import.meta.dirname, "../../..");
const DATE = new Date().toISOString().slice(0, 10);
const OUT = resolve(ROOT, "docs/ui-review", DATE);
const VIEWPORTS = [
  { name: "1440x900", size: "1440,900" },
  { name: "1280x800", size: "1280,800" },
  { name: "1024x700", size: "1024,700" },
  { name: "768x900", size: "768,900" },
  { name: "390x844", size: "390,844" },
];

async function api(path) {
  const token = (await readFile(resolve(ROOT, "data/token"), "utf8")).trim();
  const response = await fetch(BASE + path, { headers: { "x-pi-token": token } });
  if (!response.ok) throw new Error(path + " → HTTP " + response.status);
  return response.json();
}

/** Session list plus entry counts; one retry so a restarting server is not photographed by mistake. */
async function loadAgents() {
  try {
    const body = await api("/api/agents");
    return Array.isArray(body.agents) ? body.agents : [];
  } catch {
    return [];
  }
}

async function loadSessions() {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const body = await api("/api/sessions");
      const sessions = Array.isArray(body.sessions) ? body.sessions : [];
      const withCounts = [];
      for (const session of sessions) {
        const messages = await api("/api/sessions/" + session.id + "/messages");
        withCounts.push({ ...session, count: Array.isArray(messages.entries) ? messages.entries.length : 0 });
      }
      return withCounts;
    } catch (error) {
      if (attempt === 3) throw error;
      console.warn("failed to read sessions (attempt " + attempt + "):", String(error));
      await new Promise((done) => setTimeout(done, 1500));
    }
  }
  return [];
}

function shoot(url, size, file) {
  return new Promise((done) => {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=" + size,
      "--virtual-time-budget=6000",
      "--screenshot=" + file,
      url,
    ];
    const child = spawn(CHROME, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("exit", (code) => done({ code, stderr: stderr.slice(-400) }));
  });
}

if (!existsSync(CHROME)) {
  console.error("Chromium not found at " + CHROME + " — set PI_CHROME to another path.");
  process.exit(1);
}

let sessions = [];
let agents = [];
try {
  sessions = await loadSessions();
  agents = await loadAgents();
} catch (error) {
  console.error("cannot read /api/sessions — make sure 'npm run dev' is running:", String(error));
  process.exit(1);
}

const rich = sessions
  .filter((session) => session.kind !== "group")
  .sort((a, b) => b.count - a.count)[0];
const empty = sessions.find((session) => session.count === 0 && session.kind !== "group");
const group = sessions.find((session) => session.kind === "group" && session.count > 0);
const diagram = sessions.find((session) => session.title === "Request flow diagram");
const automationAgent = agents[0];
const routes = [
  { name: "00-boot", path: "/?boot=hold#/" },
  { name: "01-home", path: "/#/" },
  ...(empty ? [{ name: "02-empty-thread", path: "/#/s/" + empty.id }] : []),
  ...(rich ? [{ name: "03-chat-filled", path: "/#/s/" + rich.id }] : []),
  { name: "04-agent-list", path: "/#/agents" },
  { name: "05-agent-editor", path: "/#/agents/new" },
  ...(automationAgent ? [{ name: "05b-agent-automation", path: "/?automation=1#/agents/" + automationAgent.id }] : []),
  { name: "06-group-list", path: "/#/groups" },
  ...(group ? [{ name: "07-group-chat", path: "/#/s/" + group.id }] : []),
  ...(diagram ? [{ name: "03b-run-summary", path: "/#/s/" + diagram.id }] : []),
  ...(diagram ? [{ name: "10-diagram", path: "/?diagrams=1#/s/" + diagram.id }] : []),
  { name: "08-provider", path: "/#/providers" },
  { name: "09-system", path: "/#/system" },
  { name: "11-usage", path: "/#/usage" },
  { name: "12-notify", path: "/?notify=1&drawer=1#/agents" },
];

await mkdir(OUT, { recursive: true });
const manifest = [];
for (const route of routes) {
  for (const viewport of VIEWPORTS) {
    const file = resolve(OUT, route.name + "-" + viewport.name + ".png");
    const result = await shoot(BASE + route.path, viewport.size, file);
    const ok = result.code === 0 && existsSync(file);
    console.log((ok ? "ok   " : "FAIL ") + " " + file.replace(ROOT + "/", ""));
    if (!ok && result.stderr) console.log("      " + result.stderr.replace(/\n/g, " "));
    manifest.push({ route: route.name, viewport: viewport.name, file: file.replace(ROOT + "/", ""), ok });
  }
}
await writeFile(resolve(OUT, "manifest.json"), JSON.stringify({ base: BASE, shots: manifest }, null, 2));

const findingsPath = resolve(OUT, "findings.md");
if (!existsSync(findingsPath)) {
  await writeFile(
    findingsPath,
    "# UI review findings\n\nRubric: docs/ui-review/checklist.md\n\n| # | Screenshot | Finding | Fix | Status |\n| --- | --- | --- | --- | --- |\n",
  );
}
console.log("\nscreenshots in " + OUT.replace(ROOT + "/", "") + " — fill in findings.md after reviewing.");