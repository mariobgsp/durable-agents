import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { type Parsed, has } from "../args.ts";
import { fail, json, paint, print, table } from "../output.ts";

const RECOMMENDED: Record<string, { value: string; kernelDefault: string }> = {
  "vm.swappiness": { value: "150", kernelDefault: "60" },
  "vm.page-cluster": { value: "0", kernelDefault: "3" },
  "vm.vfs_cache_pressure": { value: "50", kernelDefault: "100" },
  "vm.watermark_boost_factor": { value: "0", kernelDefault: "15000" },
};

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

async function readSysctl(key: string): Promise<string | undefined> {
  const result = await run("sysctl", ["-n", key]);
  return result.code === 0 ? result.text.trim() : undefined;
}

export async function runTune(parsed: Parsed): Promise<void> {
  const [action = "status"] = parsed.positional;
  const rows: string[][] = [];
  const missing: string[] = [];

  for (const [key, spec] of Object.entries(RECOMMENDED)) {
    const current = await readSysctl(key);
    const state =
      current === spec.value
        ? paint("green", "set")
        : current === undefined
          ? paint("yellow", "absent")
          : current === spec.kernelDefault
            ? paint("yellow", "kernel default")
            : paint("dim", "custom (left alone)");
    rows.push([key, current ?? "-", spec.value, state]);
    if (current === undefined || current === spec.kernelDefault) missing.push(key);
  }

  const zram = await run("zramctl", ["--noheadings", "--output", "NAME,ALGORITHM,DISKSIZE", "/dev/zram0"]);
  const zramText = zram.code === 0 ? zram.text.replace(/\s+/g, " ").trim() : "none";
  const swap = await run("swapon", ["--show", "--noheadings"]);
  const memory = await readFile("/proc/meminfo", "utf8");
  const total = /MemTotal:\s+(\d+)/.exec(memory)?.[1];

  if (has(parsed, "json")) {
    json({ sysctl: rows, zram: zramText, swap: swap.text, memTotalKb: total ? Number(total) : null, missing });
    return;
  }

  table(["sysctl", "current", "recommended", "state"], rows);
  print("");
  print("zram        " + zramText);
  print("swap        " + (swap.text.replace(/\n/g, " · ") || "none"));
  if (total) print("memory      " + (Number(total) / 1024 / 1024).toFixed(1) + " GiB total");

  if (action !== "apply") {
    if (missing.length > 0) print(paint("dim", "apply the missing values with: sudo dura tune apply --yes"));
    return;
  }

  if (!has(parsed, "yes")) fail("tune apply changes /etc/sysctl.d; pass --yes", 4);
  if (zramText === "none") {
    print(paint("yellow", "no zram device; install zram-generator and add [zram0] zram-size=min(ram/2, 8192), compression-algorithm=zstd"));
  }
  if (missing.length === 0) {
    print("nothing to change");
    return;
  }
  const lines = ["# dura-agents memory tuning (written by dura tune apply)", ...missing.map((key) => key + " = " + RECOMMENDED[key]?.value)];
  const body = lines.join("\n") + "\n";
  const target = "/etc/sysctl.d/90-dura.conf";
  const child = spawn("sudo", ["tee", target]);
  child.stdin.write(body);
  child.stdin.end();
  const code = await new Promise<number>((done) => child.on("exit", (value) => done(value ?? -1)));
  if (code !== 0) fail("could not write " + target, 1);
  const reload = await run("sudo", ["sysctl", "--system"]);
  if (reload.code !== 0) fail(reload.text || "sysctl --system failed", 1);
  print(paint("green", "applied") + " " + missing.join(", "));
}
