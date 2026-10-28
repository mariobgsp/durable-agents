#!/usr/bin/env node
/** Run every E2E scenario. Each scenario owns its daemon and fake Bot API. */
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const HERE = import.meta.dirname;
const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const files = (await readdir(resolve(HERE, "scenarios"))).filter((name) => name.endsWith(".mjs")).toSorted();

let passed = 0;
const failures = [];
for (const file of files) {
  const scenario = (await import(resolve(HERE, "scenarios", file))).default;
  if (!scenario) continue;
  if (args.length > 0 && !args.some((name) => scenario.name.includes(name))) continue;
  const started = Date.now();
  try {
    await scenario.run();
    passed += 1;
    console.log("PASS " + scenario.name + " (" + (Date.now() - started) + "ms)");
  } catch (error) {
    failures.push({ name: scenario.name, error });
    console.log("FAIL " + scenario.name + " (" + (Date.now() - started) + "ms)");
    console.log("     " + String(error && error.stack ? error.stack : error).split("\n").join("\n     "));
  }
}
console.log("\n" + passed + " passed, " + failures.length + " failed");
process.exit(failures.length === 0 ? 0 : 1);
