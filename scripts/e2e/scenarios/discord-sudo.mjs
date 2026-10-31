import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startHarness } from "../harness.mjs";

/**
 * The Discord path keeps its own pending-question map; this scenario proves the approve button resumes
 * the tool, executes, and the answer reaches the channel.
 */
const CONFIG = {
  version: 1,
  mode: "fixed",
  installedAt: 1,
  user: "e2e",
  os: { id: "fedora", name: "Fedora Linux 41", versionId: "41", family: "fedora" },
  manager: "dnf",
  probe: ["/usr/bin/sync"],
  cachePaths: ["/var/cache/dnf"],
  commands: {
    update: [["/usr/bin/dnf", "-y", "upgrade", "--refresh"]],
    cleanup: [["/usr/bin/dnf", "clean", "all"]],
    memory: [["/usr/bin/sync"], ["/usr/bin/sysctl", "-w", "vm.drop_caches=3"]],
  },
};

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

export default {
  name: "discord-sudo",
  async run() {
    const h = await startHarness({
      platform: "discord",
      script: [
        { toolCall: { name: "sudo", arguments: { action: "cleanup" } } },
        { text: "Waiting for approval." },
        { toolCall: { name: "sudo", arguments: { action: "cleanup" } } },
        { text: "cleanup finished" },
      ],
      agents: [{ id: "helper", name: "Helper" }],
    });
    try {
      await h.waitFor(() => h.fake.identifyCount("main") > 0, 20_000, "Discord gateway identify");
      await sleep(300);
      await writeFile(resolve(h.home, "sudo.json"), JSON.stringify(CONFIG, null, 2) + "\n", { mode: 0o600 });
      h.discordDM("main", "clean the caches");
      const question = await h.waitFor(
        () => h.fake.sent("main").find((entry) => entry.content.includes("Clean system caches")),
        25_000,
        "the sudo approval question",
      );
      assert.ok(question.components?.length > 0, "the approval carries components");
      const customId = question.components[0].components[0].custom_id;
      h.discordClick("main", customId, {
        channelId: "dm-" + h.owner,
        messageId: question.messageId,
      });
      await h.waitFor(
        () =>
          h.fake.edits("main").find((entry) => entry.content.includes("cleanup finished")) ??
          h.fake.sent("main").find((entry) => entry.content.includes("cleanup finished")),
        25_000,
        "the final answer",
      );
      const log = await readFile(resolve(h.home, "logs/daemon.log"), "utf8").catch(() => "");
      assert.ok(log.includes("discord.sudo_answered"), "the Discord approval is logged");
      assert.ok(log.includes("sudo.run"), "the approved run is logged");
    } finally {
      await h.stop();
    }
  },
};
