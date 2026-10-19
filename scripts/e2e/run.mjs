#!/usr/bin/env node
/**
 * Run every E2E scenario. Each scenario boots its own throwaway server, so they cannot leak state into
 * each other. Usage: node scripts/e2e/run.mjs [name...] [--real]
 */
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startServer } from "./harness.mjs";

const HERE = import.meta.dirname;
const args = process.argv.slice(2);
const real = args.includes("--real");
const wanted = args.filter((arg) => !arg.startsWith("--"));

const dir = resolve(HERE, "scenarios");
const files = (await readdir(dir)).filter((name) => name.endsWith(".mjs")).toSorted();

let passed = 0;
const failures = [];

for (const file of files) {
  const scenario = (await import(resolve(dir, file))).default;
  if (!scenario) {
    console.log("SKIP " + file + " (no default export)");
    continue;
  }
  if (scenario.real === true && !real) {
    console.log("SKIP " + scenario.name + " (needs --real)");
    continue;
  }
  if (wanted.length > 0 && !wanted.some((name) => scenario.name.includes(name))) continue;

  const started = Date.now();
  let server;
  try {
    server = await startServer({ real: scenario.real === true, env: scenario.env });
    await scenario.run(server);
    passed += 1;
    console.log("PASS " + scenario.name + " (" + (Date.now() - started) + "ms)");
  } catch (error) {
    failures.push({ name: scenario.name, error });
    console.log("FAIL " + scenario.name + " (" + (Date.now() - started) + "ms)");
    console.log("     " + String(error && error.message ? error.message : error).split("\n").join("\n     "));
  } finally {
    if (server) await server.stop();
  }
}

console.log("\n" + passed + " passed, " + failures.length + " failed");
process.exit(failures.length === 0 ? 0 : 1);
