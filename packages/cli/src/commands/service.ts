import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { type Parsed, has } from "../args.ts";
import { fail, json, kv, print, paint } from "../output.ts";
import { duraHome, repoRoot } from "../../../core/src/paths.ts";

const UNIT = "dura.service";
const unitPath = resolve(homedir(), ".config/systemd/user", UNIT);
const binPath = resolve(import.meta.dirname, "../../bin/dura.ts");

function run(command: string, args: string[]): Promise<{ code: number; text: string }> {
  return new Promise((done) => {
    const child = spawn(command, args);
    let text = "";
    child.stdout.on("data", (chunk) => (text += String(chunk)));
    child.stderr.on("data", (chunk) => (text += String(chunk)));
    child.on("error", () => done({ code: -1, text: command + " is not available" }));
    child.on("exit", (code) => done({ code: code ?? -1, text: text.trim() }));
  });
}

function systemctl(args: string[]): Promise<{ code: number; text: string }> {
  return run("systemctl", ["--user", ...args]);
}

export type BootFacts = { path: string; installed: boolean; enabled: boolean; linger: boolean };

/**
 * What decides whether a reboot brings the daemon back: the unit file, its enablement, and lingering.
 *
 * Read back from systemd rather than assumed from the command that was just run: `enable --now` can
 * succeed while `loginctl enable-linger` fails (it needs polkit or root), and only linger starts the
 * user manager at boot instead of at the next login.
 */
export async function bootFacts(): Promise<BootFacts> {
  const installed = await stat(unitPath).then(
    () => true,
    () => false,
  );
  const [enabled, linger] = await Promise.all([
    systemctl(["is-enabled", UNIT]),
    run("loginctl", ["show-user", process.env.USER ?? "", "--property=Linger"]),
  ]);
  return {
    path: unitPath,
    installed,
    enabled: enabled.text.trim() === "enabled",
    linger: /^Linger=yes$/m.test(linger.text),
  };
}

/** The one sentence that answers "will this come back after a reboot?". */
function bootVerdict(facts: BootFacts): string {
  const missing = [
    facts.installed ? null : "no unit file",
    facts.enabled ? null : "unit not enabled",
    facts.linger ? null : "lingering is off",
  ].filter((entry): entry is string => entry !== null);
  return missing.length === 0
    ? paint("green", "starts at boot: yes")
    : paint("yellow", "starts at boot: no (" + missing.join(" · ") + ")");
}

function unitText(): string {
  return [
    "[Unit]",
    "Description=dura-agents daemon (CLI + one chat surface)",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=" + repoRoot,
    "Environment=DURA_HOME=" + duraHome,
    "Environment=DURA_LOG_LEVEL=info",
    // Absolute node path: the user manager's PATH does not necessarily contain mise's node shim.
    "Environment=\"NODE_OPTIONS=--max-old-space-size=1400 --max-semi-space-size=16\"",
    "Environment=NODE_COMPILE_CACHE=" + duraHome + "/cache/node",
    "ExecStart=" + process.execPath + " " + binPath + " start --foreground",
    "Restart=always",
    "RestartSec=3",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=20",
    "# Memory budget: five agents with full tools under 2 GB.",
    "MemoryHigh=1700M",
    "MemoryMax=2G",
    "MemorySwapMax=1G",
    "TasksMax=512",
    "# The permission tier is a policy, not a sandbox. The account and MemoryMax are the boundary.",
    "ProtectSystem=strict",
    "ReadWritePaths=%h",
    "PrivateTmp=yes",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectControlGroups=yes",
    "ProtectClock=yes",
    "ProtectHostname=yes",
    "RestrictSUIDSGID=yes",
    "NoNewPrivileges=yes",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export async function runService(parsed: Parsed): Promise<void> {
  const [action = "status"] = parsed.positional;
  if (action === "install") {
    await mkdir(dirname(unitPath), { recursive: true });
    await writeFile(unitPath, unitText(), { mode: 0o644 });
    await systemctl(["daemon-reload"]);
    const enabled = await systemctl(["enable", "--now", UNIT]);
    if (enabled.code !== 0) fail(enabled.text || "systemctl could not enable " + UNIT, 1);
    // Not fatal for the unit, fatal for boot survival: report the failure and the exact remedy instead
    // of throwing, so `dura init` still finishes and the operator learns what is missing.
    const linger = await run("loginctl", ["enable-linger", process.env.USER ?? ""]);
    const facts = await bootFacts();
    print(paint("green", "installed") + " " + unitPath);
    print(bootVerdict(facts));
    if (!facts.linger) {
      print(paint("yellow", "finish boot survival with: sudo loginctl enable-linger " + (process.env.USER ?? "")));
      if (linger.code !== 0 && linger.text) print(paint("dim", linger.text));
    }
    print("started and enabled · logs: journalctl --user -u " + UNIT + " -f");
    return;
  }
  if (action === "uninstall") {
    await systemctl(["disable", "--now", UNIT]);
    await rm(unitPath, { force: true });
    await systemctl(["daemon-reload"]);
    print("removed " + unitPath);
    return;
  }
  if (action === "status") {
    const facts = await bootFacts();
    if (has(parsed, "json")) {
      json({ ...facts, startsAtBoot: facts.installed && facts.enabled && facts.linger });
      return;
    }
    kv([
      ["unit", unitPath + (facts.installed ? "" : paint("yellow", " · missing"))],
      ["enabled", facts.enabled ? paint("green", "yes") : paint("yellow", "no")],
      ["linger", facts.linger ? paint("green", "yes") : paint("yellow", "no")],
      ["boot", bootVerdict(facts)],
    ]);
    const status = await systemctl(["status", UNIT, "--no-pager"]);
    if (status.text) print(paint("dim", status.text));
    return;
  }
  fail("usage: dura service <install|uninstall|status>", 2);
}
