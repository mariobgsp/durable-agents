import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { startHarness } from "../harness.mjs";
import { ROOT } from "../harness.mjs";

export default {
  name: "tui-json",
  async run() {
    const h = await startHarness({ agents: [{ id: "helper", name: "Helper" }] });
    try {
      const result = await new Promise((done) => {
        const child = spawn(process.execPath, ["packages/cli/bin/dura.ts", "monitor", "--json"], {
          cwd: ROOT,
          env: { ...process.env, DURA_HOME: h.home },
          stdio: ["ignore", "pipe", "pipe"],
        });
        // The subject is what a script reads off stdout. stderr carries warnings from dependencies and is
        // reported only when the command fails, so that unrelated noise cannot fail this test.
        let text = "";
        let errors = "";
        child.stdout.on("data", (chunk) => (text += String(chunk)));
        child.stderr.on("data", (chunk) => (errors += String(chunk)));
        child.on("exit", (code) => done({ code, text, errors }));
      });
      assert.equal(result.code, 0, result.errors || result.text);
      const fleet = JSON.parse(result.text);
      assert.equal(fleet.agents.length, 1);
      assert.equal(fleet.agents[0].id, "helper");
      assert.ok(typeof fleet.generatedAt === "number");
    } finally {
      await h.stop();
    }
  },
};
