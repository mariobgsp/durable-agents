import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

/**
 * What this host is, and which maintenance commands it can run.
 *
 * The daemon must work on Fedora, Debian, Arch, openSUSE, Alpine and the RHEL family without a table of
 * hard-coded paths. This module reads /etc/os-release for the name, confirms the family against the
 * binaries that actually exist, and returns absolute command arrays. The installer writes exactly those
 * arrays into sudoers; the tool later runs exactly the arrays recorded in sudo.json, so the two can never
 * drift apart silently.
 */

export type DistroFamily = "fedora" | "debian" | "arch" | "suse" | "alpine" | "unknown";
export type PackageManager = "dnf" | "dnf5" | "yum" | "apt-get" | "pacman" | "zypper" | "apk" | "unknown";
export type SudoMode = "fixed" | "root";
export type Command = string[];
export type MaintenanceCommands = { update: Command[]; cleanup: Command[]; memory: Command[] };

export type OsInfo = {
  id: string;
  like: string[];
  name: string;
  prettyName: string;
  versionId: string;
  family: DistroFamily;
};

export type Tools = {
  sudo?: string;
  systemdRun?: string;
  journalctl?: string;
  systemdTmpfiles?: string;
  sysctl?: string;
  sync?: string;
  truePath?: string;
  dnf?: string;
  dnf5?: string;
  yum?: string;
  aptGet?: string;
  pacman?: string;
  paccache?: string;
  zypper?: string;
  apk?: string;
};

export type Maintenance = {
  os: OsInfo;
  manager: PackageManager;
  tools: Tools;
  commands: MaintenanceCommands;
  cachePaths: string[];
  unsupported: string[];
  systemd: boolean;
  atomic: boolean;
};

const FAMILIES: ReadonlyArray<{ family: DistroFamily; ids: readonly string[] }> = [
  { family: "fedora", ids: ["fedora", "rhel", "centos", "rocky", "almalinux", "alma", "oracle", "ol", "amzn"] },
  { family: "debian", ids: ["debian", "ubuntu", "linuxmint", "mint", "pop", "kali", "raspbian", "neon", "elementary", "zorin"] },
  { family: "arch", ids: ["arch", "archlinux", "omarchy", "manjaro", "endeavouros", "garuda", "artix"] },
  { family: "suse", ids: ["opensuse", "opensuse-leap", "opensuse-tumbleweed", "sles", "sled", "suse"] },
  { family: "alpine", ids: ["alpine"] },
];

/** Parse the key=value file, unquoting values and keeping the fields the families need. */
export function parseOsRelease(text: string): OsInfo {
  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const equal = line.indexOf("=");
    if (equal <= 0) continue;
    const key = line.slice(0, equal).trim();
    let value = line.slice(equal + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
      value = value.replace(/\\(["'\\$])/g, "$1");
    }
    values.set(key, value);
  }
  const id = (values.get("ID") ?? "").toLowerCase();
  const like = (values.get("ID_LIKE") ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const name = values.get("NAME") ?? values.get("PRETTY_NAME") ?? "Linux";
  return {
    id,
    like,
    name,
    prettyName: values.get("PRETTY_NAME") ?? name,
    versionId: values.get("VERSION_ID") ?? "",
    family: familyOf(id, like),
  };
}

export function familyOf(id: string, like: readonly string[]): DistroFamily {
  const tokens = new Set<string>();
  if (id) tokens.add(id.toLowerCase());
  for (const value of like) tokens.add(value.toLowerCase());
  for (const entry of FAMILIES) {
    if (entry.ids.some((known) => tokens.has(known))) return entry.family;
  }
  return "unknown";
}

/** Resolve a command the way the shell would, but without a shell. */
export async function resolveBinary(name: string): Promise<string | undefined> {
  if (name.includes("/")) {
    try {
      await access(name, constants.X_OK);
      return name;
    } catch {
      return undefined;
    }
  }
  const directories = new Set<string>();
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length > 0) directories.add(directory);
  }
  for (const directory of ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"]) {
    directories.add(directory);
  }
  for (const directory of directories) {
    const candidate = join(directory, name);
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this directory; try the next one.
    }
  }
  return undefined;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function managerBinary(manager: PackageManager, tools: Tools): string | undefined {
  switch (manager) {
    case "dnf":
      return tools.dnf;
    case "dnf5":
      return tools.dnf5;
    case "yum":
      return tools.yum;
    case "apt-get":
      return tools.aptGet;
    case "pacman":
      return tools.pacman;
    case "zypper":
      return tools.zypper;
    case "apk":
      return tools.apk;
    case "unknown":
      return undefined;
  }
}

function preferredManager(family: DistroFamily): PackageManager | undefined {
  switch (family) {
    case "fedora":
      return "dnf";
    case "debian":
      return "apt-get";
    case "arch":
      return "pacman";
    case "suse":
      return "zypper";
    case "alpine":
      return "apk";
    case "unknown":
      return undefined;
  }
}

export function cachePathsFor(manager: PackageManager): string[] {
  switch (manager) {
    case "dnf":
    case "dnf5":
      return ["/var/cache/dnf", "/var/cache/libdnf5"];
    case "yum":
      return ["/var/cache/yum"];
    case "apt-get":
      return ["/var/cache/apt/archives"];
    case "pacman":
      return ["/var/cache/pacman/pkg"];
    case "zypper":
      return ["/var/cache/zypp"];
    case "apk":
      return ["/var/cache/apk"];
    case "unknown":
      return [];
  }
}

/**
 * Build the command arrays for one manager. Every command is absolute and argument-complete; the sudoers
 * file allows exactly these strings, and the tool runs exactly these strings.
 */
export function commandsFor(
  manager: PackageManager,
  tools: Tools,
  options: { systemd?: boolean; atomic?: boolean } = {},
): { commands: MaintenanceCommands; unsupported: string[] } {
  const commands: MaintenanceCommands = { update: [], cleanup: [], memory: [] };
  const unsupported: string[] = [];
  const systemd = options.systemd !== false;
  const atomic = options.atomic === true;

  if (atomic) {
    unsupported.push("Fedora atomic (rpm-ostree) manages system updates itself; use rpm-ostree, or --root for manual commands.");
  } else {
    switch (manager) {
      case "dnf": {
        const dnf = tools.dnf;
        if (dnf) {
          commands.update.push([dnf, "-y", "upgrade", "--refresh"]);
          commands.cleanup.push([dnf, "clean", "all"]);
        }
        break;
      }
      case "dnf5": {
        const dnf5 = tools.dnf5;
        if (dnf5) {
          commands.update.push([dnf5, "-y", "upgrade", "--refresh"]);
          commands.cleanup.push([dnf5, "clean", "all"]);
        }
        break;
      }
      case "yum": {
        const yum = tools.yum;
        if (yum) {
          commands.update.push([yum, "-y", "update"]);
          commands.cleanup.push([yum, "clean", "all"]);
        }
        break;
      }
      case "apt-get": {
        const apt = tools.aptGet;
        if (apt) {
          commands.update.push([apt, "update"], [apt, "-y", "full-upgrade"]);
          commands.cleanup.push([apt, "clean"]);
        }
        break;
      }
      case "pacman": {
        const pacman = tools.pacman;
        if (pacman) {
          commands.update.push([pacman, "-Syu", "--noconfirm"]);
          const paccache = tools.paccache;
          commands.cleanup.push(paccache ? [paccache, "-rk2"] : [pacman, "-Sc", "--noconfirm"]);
        }
        break;
      }
      case "zypper": {
        const zypper = tools.zypper;
        if (zypper) {
          commands.update.push([zypper, "--non-interactive", "update"]);
          commands.cleanup.push([zypper, "--non-interactive", "clean", "--all"]);
        }
        break;
      }
      case "apk": {
        const apk = tools.apk;
        if (apk) {
          commands.update.push([apk, "upgrade", "--no-interactive"]);
          commands.cleanup.push([apk, "cache", "clean"]);
        }
        break;
      }
      case "unknown":
        break;
    }
  }

  const journalctl = tools.journalctl;
  if (systemd && journalctl) commands.cleanup.push([journalctl, "--vacuum-size=200M"]);
  const tmpfiles = tools.systemdTmpfiles;
  if (systemd && tmpfiles) commands.cleanup.push([tmpfiles, "--clean"]);

  const sync = tools.sync;
  const sysctl = tools.sysctl;
  if (sync && sysctl) commands.memory.push([sync], [sysctl, "-w", "vm.drop_caches=3"]);

  if (commands.update.length === 0 && !atomic) {
    unsupported.push(
      manager === "unknown"
        ? "No supported package manager was detected; update and package-cache cleanup are unavailable."
        : "The detected package manager binary was not found.",
    );
  }
  if (commands.cleanup.length === 0) {
    unsupported.push("No package cache cleaner, journalctl, or systemd-tmpfiles was found; cleanup is unavailable.");
  }
  if (commands.memory.length === 0) {
    unsupported.push("Memory cleanup needs both sync and sysctl.");
  }
  return { commands, unsupported };
}

/** The sudoers file: one exact rule per detected command, or one ALL rule in root mode. */
export function sudoersContent(user: string, commands: MaintenanceCommands, mode: SudoMode): string {
  if (!/^[A-Za-z0-9._-]+$/.test(user)) {
    throw new Error("unsupported user name for sudoers: " + JSON.stringify(user));
  }
  const lines = ["# Managed by durable-agents (dura sudo install). Re-run after OS or tool upgrades."];
  if (mode === "root") {
    lines.push(user + " ALL=(root) NOPASSWD: ALL");
    return lines.join("\n") + "\n";
  }
  const seen = new Set<string>();
  for (const command of [...commands.update, ...commands.cleanup, ...commands.memory]) {
    const text = command.join(" ");
    if (seen.has(text)) continue;
    seen.add(text);
    for (const argument of command) {
      if (/[\s,:#'"\\]/.test(argument)) {
        throw new Error("unsupported sudoers argument: " + JSON.stringify(argument));
      }
    }
    lines.push(user + " ALL=(root) NOPASSWD: " + text);
  }
  if (seen.size === 0) {
    throw new Error("no maintenance commands were detected for this host");
  }
  return lines.join("\n") + "\n";
}

/** Read the host once: os-release, package manager, systemd, tools and the exact command sets. */
export async function detectMaintenance(): Promise<Maintenance> {
  const release = await readFile("/etc/os-release", "utf8").catch(() => "");
  const os = parseOsRelease(release);

  const [
    sudo,
    systemdRun,
    journalctl,
    systemdTmpfiles,
    sysctl,
    sync,
    truePath,
    dnf,
    dnf5,
    yum,
    aptGet,
    pacman,
    paccache,
    zypper,
    apk,
  ] = await Promise.all([
    resolveBinary("sudo"),
    resolveBinary("systemd-run"),
    resolveBinary("journalctl"),
    resolveBinary("systemd-tmpfiles"),
    resolveBinary("sysctl"),
    resolveBinary("sync"),
    resolveBinary("true"),
    resolveBinary("dnf"),
    resolveBinary("dnf5"),
    resolveBinary("yum"),
    resolveBinary("apt-get"),
    resolveBinary("pacman"),
    resolveBinary("paccache"),
    resolveBinary("zypper"),
    resolveBinary("apk"),
  ]);

  const tools: Tools = {
    ...(sudo ? { sudo } : {}),
    ...(systemdRun ? { systemdRun } : {}),
    ...(journalctl ? { journalctl } : {}),
    ...(systemdTmpfiles ? { systemdTmpfiles } : {}),
    ...(sysctl ? { sysctl } : {}),
    ...(sync ? { sync } : {}),
    ...(truePath ? { truePath } : {}),
    ...(dnf ? { dnf } : {}),
    ...(dnf5 ? { dnf5 } : {}),
    ...(yum ? { yum } : {}),
    ...(aptGet ? { aptGet } : {}),
    ...(pacman ? { pacman } : {}),
    ...(paccache ? { paccache } : {}),
    ...(zypper ? { zypper } : {}),
    ...(apk ? { apk } : {}),
  };

  const preferred = preferredManager(os.family);
  const order: PackageManager[] = [];
  for (const manager of [preferred, "dnf", "dnf5", "yum", "apt-get", "pacman", "zypper", "apk"] as const) {
    if (manager && !order.includes(manager)) order.push(manager);
  }
  let manager: PackageManager = "unknown";
  for (const candidate of order) {
    if (managerBinary(candidate, tools)) {
      manager = candidate;
      break;
    }
  }

  const systemd = await isDirectory("/run/systemd/system");
  const atomic = await exists("/run/ostree-booted");
  const { commands, unsupported } = commandsFor(manager, tools, { systemd, atomic });
  return {
    os,
    manager,
    tools,
    commands,
    cachePaths: cachePathsFor(manager),
    unsupported,
    systemd,
    atomic,
  };
}
