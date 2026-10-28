import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ROOT } from "../harness.mjs";

export default {
  name: "provider-catalog",
  async run() {
    const home = await mkdtemp(resolve(tmpdir(), "dura-provider-"));
    try {
      const output = await new Promise((done) => {
        const child = spawn(process.execPath, ["packages/cli/bin/dura.ts", "provider", "list", "--all"], {
          cwd: ROOT,
          env: { ...process.env, DURA_HOME: home },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let text = "";
        child.stdout.on("data", (chunk) => (text += String(chunk)));
        child.stderr.on("data", (chunk) => (text += String(chunk)));
        child.on("exit", (code) => done({ code, text }));
      });
      assert.equal(output.code, 0, output.text);
      assert.ok(output.text.includes("opencode-go"), "the current provider is listed");
      const rows = output.text.split("\n").filter((line) => /^[a-z0-9-]+\s{2,}/.test(line));
      assert.ok(rows.length >= 30, "the built-in catalog is listed (" + rows.length + " rows)");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
};
