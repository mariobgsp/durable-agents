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
        let text = "";
        child.stdout.on("data", (chunk) => (text += String(chunk)));
        child.stderr.on("data", (chunk) => (text += String(chunk)));
        child.on("exit", (code) => done({ code, text }));
      });
      assert.equal(result.code, 0, result.text);
      const fleet = JSON.parse(result.text);
      assert.equal(fleet.agents.length, 1);
      assert.equal(fleet.agents[0].id, "helper");
      assert.ok(typeof fleet.generatedAt === "number");
    } finally {
      await h.stop();
    }
  },
};
