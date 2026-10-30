import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { startFakeDiscord } from "../fake-discord.mjs";
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
  name: "discord-init",
  async run() {
    const fake = await startFakeDiscord();
    fake.addBot({ label: "main", username: "durabot", id: "9001", token: "discord-test-token", applicationId: "app-main" });
    const home = await mkdtemp(resolve(tmpdir(), "dura-init-discord-"));
    try {
      const result = await run(
        [
          "packages/cli/bin/dura.ts",
          "init",
          "--yes",
          "--platform",
          "discord",
          "--discord-token",
          "discord-test-token",
          "--discord-label",
          "main",
          "--owner-id",
          "100",
          "--no-service",
          "--no-tune",
          "--no-migrate",
          "--skip-test",
        ],
        { DURA_HOME: home, DURA_E2E: "1", DURA_DISCORD_API_BASE: fake.base, DURA_DISCORD_GATEWAY_URL: fake.gatewayUrl },
      );
      assert.equal(result.code, 0, result.output);
      const config = JSON.parse(await readFile(resolve(home, "config.json"), "utf8"));
      assert.equal(config.chat.active, "discord");
      for (const step of ["agents", "provider", "chat:discord", "service"]) {
        assert.ok(config.setup.completed.includes(step), step + " completed");
      }
      const registry = JSON.parse(await readFile(resolve(home, "secrets", "discord.json"), "utf8"));
      assert.equal(registry.bots[0].label, "main");
      assert.equal(registry.bots[0].defaultAgent, "orchestrator");
      const users = JSON.parse(await readFile(resolve(home, "discord", "users.json"), "utf8"));
      assert.equal(users.owner, "100");
      assert.ok(!("telegram" in config.setup.completed), "only the chosen surface is recorded");
    } finally {
      await fake.close();
      await rm(home, { recursive: true, force: true });
    }
  },
};
