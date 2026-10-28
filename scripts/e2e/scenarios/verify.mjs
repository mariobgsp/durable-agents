import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

export default {
  name: "verify",
  async run() {
    const h = await startHarness({
      script: [{ text: "OK" }, { text: "I am alive." }],
      agents: [{ id: "helper", name: "Helper" }],
    });
    try {
      const result = await h.client.request("verify.run", { agentPing: true }, 120_000);
      const failed = result.checks.filter((check) => check.required && !check.ok);
      assert.deepEqual(failed.map((check) => check.name), [], "no required check failed");
      const names = result.checks.map((check) => check.name);
      for (const required of ["home-writable", "config-mode", "provider-completion", "agents", "ipc-socket", "no-tcp-listener", "sqlite", "agent-ping"]) {
        assert.ok(names.includes(required), required + " ran");
      }
      assert.equal(result.ok, true);
    } finally {
      await h.stop();
    }
  },
};
