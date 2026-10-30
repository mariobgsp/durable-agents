import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { startFakeTelegram } from "../fake-telegram.mjs";
import { ROOT } from "../harness.mjs";

function run(args, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    child.on("exit", (code) => done({ code, output }));
  });
}

export default {
  name: "init-wizard",
  async run() {
    const fake = await startFakeTelegram();
    fake.addBot({ label: "main", username: "mainbot", id: 1001, token: "1001:test-token" });
    const home = await mkdtemp(resolve(tmpdir(), "dura-init-"));
    try {
      const result = await run(
        [
          "packages/cli/bin/dura.ts",
          "init",
          "--yes",
          "--token",
          "main:1001:test-token",
          "--owner-id",
          "100",
          "--no-service",
          "--no-tune",
          "--no-migrate",
          "--skip-test",
        ],
        { DURA_HOME: home, DURA_TELEGRAM_API_BASE: fake.base, DURA_E2E: "1" },
      );
      assert.equal(result.code, 0, result.output);
      const config = JSON.parse(await readFile(resolve(home, "config.json"), "utf8"));
      assert.equal(config.orchestrator.agentId, "orchestrator");
      for (const step of ["agents", "provider", "chat:telegram", "service"]) {
        assert.ok(config.setup.completed.includes(step), step + " completed");
      }
      assert.ok(!config.setup.completed.includes("test"), "test was skipped");
      const users = JSON.parse(await readFile(resolve(home, "telegram", "users.json"), "utf8"));
      assert.equal(users.owner, "100");
      const registry = JSON.parse(await readFile(resolve(home, "secrets", "telegram.json"), "utf8"));
      assert.equal(registry.bots[0].label, "main");
      const agent = JSON.parse(await readFile(resolve(home, "agents", "orchestrator", "agent.json"), "utf8"));
      assert.equal(agent.telegramBot, "main");
      assert.equal(agent.permissions, "full");
    } finally {
      await fake.close();
      await rm(home, { recursive: true, force: true });
    }
  },
};
