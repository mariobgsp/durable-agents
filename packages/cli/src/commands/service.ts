import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { type Parsed, has } from "../args.ts";
import { fail, print, paint } from "../output.ts";
import { duraHome, repoRoot } from "../../../core/src/paths.ts";

const UNIT = "dura.service";
const unitPath = resolve(homedir(), ".config/systemd/user", UNIT);
const binPath = resolve(import.meta.dirname, "../../bin/dura.ts");

function systemctl(args: string[]): Promise<{ code: number; text: string }> {
  return new Promise((done) => {
    const child = spawn("systemctl", ["--user", ...args]);
    let text = "";
    child.stdout.on("data", (chunk) => (text += String(chunk)));
    child.stderr.on("data", (chunk) => (text += String(chunk)));
    child.on("error", () => done({ code: -1, text: "systemctl is not available" }));
    child.on("exit", (code) => done({ code: code ?? -1, text: text.trim() }));
  });
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
    "Environment=NODE_OPTIONS=--max-old-space-size=1400 --max-semi-space-size=16",
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
    await new Promise<void>((done) => {
      const child = spawn("loginctl", ["enable-linger", process.env.USER ?? ""], { stdio: "ignore" });
      child.on("exit", () => done());
      child.on("error", () => done());
    });
    print(paint("green", "installed") + " " + unitPath);
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
    const status = await systemctl(["status", UNIT, "--no-pager"]);
    print(status.text || (has(parsed, "json") ? "{}" : "service not available"));
    return;
  }
  fail("usage: dura service <install|uninstall|status>", 2);
}
