import { spawn } from "node:child_process";
import { readFile, stat, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { type Parsed, has } from "../args.ts";
import { bytes, json, paint, print, table } from "../output.ts";
import { DaemonClient, DaemonUnavailable } from "../client.ts";
import { readConfig, validateConfig } from "../../../core/src/config.ts";
import { discordBotsPath, duraHome, telegramBotsPath } from "../../../core/src/paths.ts";
import { models } from "../../../core/src/models.ts";

type Row = { check: string; ok: boolean; detail: string };

function run(command: string, args: string[]): Promise<{ code: number; text: string }> {
  return new Promise((done) => {
    const child = spawn(command, args);
    let text = "";
    child.stdout.on("data", (chunk) => (text += String(chunk)));
    child.stderr.on("data", (chunk) => (text += String(chunk)));
    child.on("error", () => done({ code: -1, text: "" }));
    child.on("exit", (code) => done({ code: code ?? -1, text: text.trim() }));
  });
}

export async function runDoctor(parsed: Parsed): Promise<void> {
  const rows: Row[] = [];
  const [major, minor] = process.versions.node.split(".").map(Number);
  rows.push({
    check: "node",
    ok: (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 19),
    detail: process.version,
  });

  try {
    const info = await stat(duraHome);
    rows.push({ check: "home", ok: info.isDirectory(), detail: duraHome + " mode " + (info.mode & 0o777).toString(8) });
  } catch {
    rows.push({ check: "home", ok: false, detail: duraHome + " does not exist (run dura init)" });
  }

  try {
    const config = await readConfig({ fresh: true });
    const info = await stat(duraHome + "/config.json");
    rows.push({
      check: "config",
      ok: (info.mode & 0o077) === 0,
      detail: "parsed · mode " + (info.mode & 0o777).toString(8),
    });
    for (const provider of config.models.registered) {
      const auth = await models.getAuth(provider).catch(() => undefined);
      rows.push({
        check: "provider " + provider,
        ok: Boolean(auth),
        detail: auth ? "credential from " + (auth.source ?? "store") : "no credential",
      });
    }
    rows.push({ check: "model", ok: true, detail: config.models.default.provider + "/" + config.models.default.modelId });
    const problems = validateConfig(config);
    rows.push({
      check: "chat-surface",
      ok: problems.length === 0,
      detail: problems.length === 0 ? config.chat.active : problems.join("; "),
    });
    const active = config.chat.active;
    const registryPath = active === "discord" ? discordBotsPath : telegramBotsPath;
    try {
      const raw = JSON.parse(await readFile(registryPath, "utf8")) as { bots?: { label?: string; enabled?: boolean }[] };
      const info = await stat(registryPath);
      rows.push({
        check: "bots (" + active + ")",
        ok: (info.mode & 0o077) === 0,
        detail: (raw.bots ?? []).length + " configured · mode " + (info.mode & 0o777).toString(8),
      });
    } catch {
      rows.push({ check: "bots (" + active + ")", ok: false, detail: "no registry yet (run dura init step 3)" });
    }
    const inactive = active === "discord" ? telegramBotsPath : discordBotsPath;
    try {
      const raw = JSON.parse(await readFile(inactive, "utf8")) as { bots?: unknown[] };
      rows.push({ check: "inactive-surface", ok: true, detail: (raw.bots ?? []).length + " credentials kept but not started" });
    } catch {
      /* no inactive credentials */
    }
  } catch (error) {
    rows.push({ check: "config", ok: false, detail: String(error) });
  }

  try {
    const disk = await statfs(duraHome);
    rows.push({ check: "disk", ok: disk.bavail > 0, detail: bytes(disk.bavail * disk.bsize) + " free" });
  } catch {
    rows.push({ check: "disk", ok: false, detail: "cannot stat the home" });
  }

  const swappiness = await run("sysctl", ["-n", "vm.swappiness"]);
  const zram = await run("zramctl", ["--noheadings", "--output", "NAME,ALGORITHM,DISKSIZE", "/dev/zram0"]);
  rows.push({
    check: "zram",
    ok: zram.code === 0,
    detail: zram.code === 0 ? zram.text.replace(/\s+/g, " ") : "no zram device (dura tune)",
  });
  rows.push({ check: "swappiness", ok: true, detail: swappiness.text || "unavailable" });

  try {
    const client = await DaemonClient.connect();
    try {
      const status = (await client.request("status")) as {
        memory?: { rss?: number };
        channels?: { platform?: string; bots?: { label: string; ok?: boolean; gateway?: string }[] };
      };
      rows.push({ check: "daemon", ok: true, detail: "running · " + bytes(status.memory?.rss ?? 0) + " rss · " + (status.channels?.platform ?? "no surface") });
      const bots = status.channels?.bots ?? [];
      for (const bot of bots) {
        rows.push({ check: "bot " + bot.label, ok: bot.ok !== false, detail: bot.ok === false ? bot.gateway ?? "connection failed" : "connected" });
      }
    } finally {
      client.close();
    }
  } catch {
    rows.push({ check: "daemon", ok: false, detail: "not running" });
  }

  if (has(parsed, "json")) {
    json({ home: duraHome, checks: rows, ok: rows.every((row) => row.ok) });
  } else {
    table(["check", "", "detail"], rows.map((row) => [row.check, row.ok ? paint("green", "ok") : paint("red", "FAIL"), row.detail]));
    if (has(parsed, "fix-safe")) print(paint("yellow", "fix-safe makes no changes yet; every fix is a separate command"));
  }
  if (!rows.every((row) => row.ok)) process.exit(1);
}
