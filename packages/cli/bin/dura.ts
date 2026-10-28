#!/usr/bin/env node
import { main } from "../src/main.ts";

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(typeof (error as { exitCode?: unknown })?.exitCode === "number" ? (error as { exitCode: number }).exitCode : 1);
});
