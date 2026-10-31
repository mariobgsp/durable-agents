import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { type Parsed, has } from "../args.ts";
import { fail, json, paint, print } from "../output.ts";
import { confirm, interactive } from "../prompts.ts";
import { sudoPath } from "../../../core/src/paths.ts";
import {
  detectMaintenance,
  resolveBinary,
  sudoersContent,
  type Maintenance,
  type MaintenanceCommands,
  type SudoMode,
} from "../../../core/src/platform.ts";
import { readSudoConfig, saveSudoConfig, type SudoConfig } from "../../../core/src/sudo.ts";

/**
 * dura sudo install, uninstall, status.
 *
 * The installer is the owner's consent to the capability: it prints the exact sudoers content, asks, writes
 * it with sudo, validates with visudo, and probes the result before recording it in sudo.json. The daemon
 * never edits sudoers; the tool only runs the commands recorded here.
 */

type RunResult = { code: number; text: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quote(argument: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(argument) ? argument : JSON.stringify(argument);
}

function runSudo(
  sudo: string,
  args: string[],
  options: { inherit?: boolean; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((done) => {
    const child = options.inherit
      ? spawn(sudo, args, { stdio: "inherit" })
      : spawn(sudo, args, { stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout?.on("data", (chunk) => (text += String(chunk)));
    child.stderr?.on("data", (chunk) => (text += String(chunk)));
    child.on("error", (error) => done({ code: 127, text: error.message }));
    child.on("exit", (code) => done({ code: code ?? 1, text: text.trim() }));
    if (options.timeoutMs !== undefined) {
      const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
      timer.unref();
    }
  });
}

/** sudo tee: the content goes through stdin, so no shell sees it and no coreutils install is required. */
function runSudoInput(sudo: string, args: string[], input: string, timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((done) => {
    const child = spawn(sudo, args, { stdio: ["pipe", "ignore", "inherit"] });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    timer.unref();
    child.on("error", (error) => done({ code: 127, text: error.message }));
    child.on("exit", (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, text: "" });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}

function describe(detected: Maintenance): string {
  const os = detected.os.prettyName || detected.os.id || "Linux";
  return (
    "Detected " +
    os +
    " (" +
    detected.manager +
    ")" +
    (detected.systemd ? " · systemd" : " · no systemd") +
    (detected.atomic ? " · atomic" : "")
  );
}

function showCommands(commands: MaintenanceCommands): void {
  for (const action of ["update", "cleanup", "memory"] as const) {
    const list = commands[action];
    print(paint("bold", action) + (list.length === 0 ? " (unavailable)" : ""));
    for (const command of list) print("  " + command.map(quote).join(" "));
  }
}

async function chooseMode(parsed: Parsed): Promise<SudoMode> {
  const root = has(parsed, "root");
  const fixed = has(parsed, "fixed");
  if (root && fixed) fail("choose one of --root or --fixed", 2);
  if (root) return "root";
  if (fixed) return "fixed";
  if (!interactive()) return "fixed";
  const allow = await confirm("Allow arbitrary root commands too (the run action)?", false);
  return allow ? "root" : "fixed";
}

async function install(parsed: Parsed): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    fail(
      "Run this command as the account that runs the daemon, not as root; it will ask for your sudo password.",
      4,
    );
  }
  const mode = await chooseMode(parsed);
  const detected = await detectMaintenance();
  const user = userInfo().username;
  print(describe(detected));
  print(paint("dim", "user " + user + " · cache " + (detected.cachePaths.join(", ") || "none")));
  showCommands(detected.commands);
  if (detected.unsupported.length > 0) print(paint("dim", "notes: " + detected.unsupported.join(" ")));

  const total =
    detected.commands.update.length + detected.commands.cleanup.length + detected.commands.memory.length;
  if (mode === "fixed" && total === 0) {
    fail(
      "No maintenance commands were detected on this host. Re-run with --root for arbitrary commands, or add rules manually.",
      4,
    );
  }

  let content: string;
  try {
    content = sudoersContent(user, detected.commands, mode);
  } catch (error) {
    fail(messageOf(error), 1);
    return;
  }

  print("");
  print(paint("dim", "Will write /etc/sudoers.d/dura-agents:"));
  print(content.trimEnd());
  print("");
  if (!has(parsed, "yes")) {
    if (!interactive()) {
      fail("stdin is not a terminal; re-run with --yes to install the rule printed above.", 4);
    }
    if (!(await confirm("Install this sudoers rule?", false))) {
      print("cancelled");
      return;
    }
  }

  const sudo = await resolveBinary("sudo");
  if (!sudo) fail("sudo is not installed", 1);
  const tee = await resolveBinary("tee");
  const chmod = await resolveBinary("chmod");
  const chown = await resolveBinary("chown");
  if (!tee || !chmod || !chown) fail("tee, chmod and chown are required to install the rule", 1);
  const visudo = await resolveBinary("visudo");
  if (!visudo) fail("visudo is not on PATH; install sudo", 1);

  const target = "/etc/sudoers.d/dura-agents";
  const written = await runSudoInput(sudo, [tee, target], content);
  if (written.code !== 0) fail("could not write " + target, 1);
  const modeResult = await runSudo(sudo, [chmod, "0440", target], { inherit: true, timeoutMs: 30_000 });
  if (modeResult.code !== 0) fail("could not set 0440 on " + target, 1);
  const owner = await runSudo(sudo, [chown, "root:root", target], { inherit: true, timeoutMs: 30_000 });
  if (owner.code !== 0) fail("could not set root:root on " + target, 1);

  const check = await runSudo(sudo, [visudo, "-cf", target], {
    inherit: true,
    timeoutMs: 60_000,
  });
  if (check.code !== 0) {
    const remover = await resolveBinary("rm");
    if (remover) {
      await runSudo(sudo, [remover, "-f", target], { inherit: true, timeoutMs: 30_000 });
    }
    fail("visudo rejected the rule; the file was removed", 1);
  }

  const probe: string[] | undefined =
    mode === "root" ? [detected.tools.truePath ?? "/usr/bin/true"] : detected.commands.memory[0];
  let probeText = "skipped (no safe probe command)";
  if (probe) {
    // Clear any cached sudo timestamp first, so the probe proves the NOPASSWD rule, not a just-entered password.
    await runSudo(sudo, ["-k"], { timeoutMs: 5_000 });
    const result = await runSudo(sudo, ["-n", ...probe], { timeoutMs: 60_000 });
    if (result.code !== 0) {
      fail(
        "The rule is installed but is not effective.\n" +
          (result.text || "sudo still asks for a password.") +
          "\nEnsure /etc/sudoers contains: @includedir /etc/sudoers.d\nThen run: dura sudo status",
        1,
      );
    }
    probeText = "ok";
  } else {
    print(paint("yellow", "warning: no safe probe command; the first action will verify the rule."));
  }

  const config: SudoConfig = {
    version: 1,
    mode,
    installedAt: Date.now(),
    user,
    os: {
      id: detected.os.id,
      name: detected.os.prettyName || detected.os.name,
      versionId: detected.os.versionId,
      family: detected.os.family,
    },
    manager: detected.manager,
    probe: probe ?? [],
    cachePaths: detected.cachePaths,
    commands: detected.commands,
  };
  await saveSudoConfig(config);
  print("");
  print(
    paint("green", "installed") +
      " /etc/sudoers.d/dura-agents · " +
      mode +
      " mode · probe " +
      probeText,
  );
  print("The agent asks before every use. Remove with: dura sudo uninstall");
}

async function uninstall(parsed: Parsed): Promise<void> {
  if (!has(parsed, "yes")) {
    if (!interactive()) fail("stdin is not a terminal; re-run with --yes", 4);
    if (!(await confirm("Remove /etc/sudoers.d/dura-agents and the sudo record?", false))) {
      print("cancelled");
      return;
    }
  }
  const sudo = await resolveBinary("sudo");
  if (!sudo) fail("sudo is not installed", 1);
  const remover = await resolveBinary("rm");
  if (!remover) fail("rm is not on PATH", 1);
  const result = await runSudo(sudo, [remover, "-f", "/etc/sudoers.d/dura-agents"], {
    inherit: true,
    timeoutMs: 60_000,
  });
  if (result.code !== 0) fail("could not remove /etc/sudoers.d/dura-agents", 1);
  await rm(sudoPath, { force: true });
  print("removed /etc/sudoers.d/dura-agents and " + sudoPath);
}

async function status(parsed: Parsed): Promise<void> {
  const detected = await detectMaintenance();
  const config = await readSudoConfig();
  const sudo = await resolveBinary("sudo");
  let probe: { ok: boolean; detail: string } | undefined;
  if (config && sudo && config.probe.length > 0) {
    const result = await runSudo(sudo, ["-n", ...config.probe], { timeoutMs: 60_000 });
    probe = { ok: result.code === 0, detail: result.text || (result.code === 0 ? "ok" : "failed") };
  }
  const drift = config
    ? config.manager !== detected.manager ||
      JSON.stringify(config.commands) !== JSON.stringify(detected.commands)
    : undefined;

  if (has(parsed, "json")) {
    json({
      detected: {
        os: detected.os,
        manager: detected.manager,
        systemd: detected.systemd,
        atomic: detected.atomic,
        cachePaths: detected.cachePaths,
        commands: detected.commands,
        unsupported: detected.unsupported,
      },
      config: config ?? null,
      probe: probe ?? null,
      drift: drift ?? null,
    });
    return;
  }

  print(paint("bold", "Host"));
  print(
    "  os        " +
      (detected.os.prettyName || detected.os.id || "Linux") +
      " (" +
      detected.os.family +
      " " +
      detected.os.versionId +
      ")",
  );
  print(
    "  manager   " +
      detected.manager +
      " · systemd " +
      (detected.systemd ? "yes" : "no") +
      (detected.atomic ? " · atomic" : ""),
  );
  print("  cache     " + (detected.cachePaths.join(", ") || "none"));
  if (!config) {
    print("");
    print("Privileged actions are not installed. Run: dura sudo install");
    showCommands(detected.commands);
    if (detected.unsupported.length > 0) print(paint("dim", "notes: " + detected.unsupported.join(" ")));
    return;
  }
  print("");
  print(paint("bold", "Installed"));
  print("  mode      " + config.mode);
  print("  when      " + new Date(config.installedAt).toISOString());
  print("  user      " + config.user);
  print(
    "  probe     " +
      (probe
        ? (probe.ok ? paint("green", "ok") : paint("red", "failed")) + " · " + probe.detail.slice(0, 200)
        : "not run"),
  );
  print("  drift     " + (drift ? paint("yellow", "host changed; re-run dura sudo install") : "none"));
  showCommands(config.commands);
  if (detected.unsupported.length > 0) print(paint("dim", "notes: " + detected.unsupported.join(" ")));
}

export async function runSudoCommand(parsed: Parsed): Promise<void> {
  const [action = "status"] = parsed.positional;
  if (action === "install") {
    await install(parsed);
    return;
  }
  if (action === "uninstall") {
    await uninstall(parsed);
    return;
  }
  if (action === "status") {
    await status(parsed);
    return;
  }
  fail("usage: dura sudo <install|uninstall|status> [--root|--fixed] [--yes] [--json]", 2);
}
