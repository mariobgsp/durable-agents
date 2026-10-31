import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startHarness } from "../harness.mjs";

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
  name: "sudo-deny",
  async run() {
    const h = await startHarness({
      script: [
        { toolCall: { name: "sudo", arguments: { action: "cleanup" } } },
        { text: "Waiting for approval." },
        { text: "not cleaned" },
      ],
      agents: [{ id: "helper", name: "Helper" }],
    });
    try {
      await writeFile(resolve(h.home, "sudo.json"), JSON.stringify(CONFIG, null, 2) + "\n", { mode: 0o600 });
      h.text("main", 100, "clean the caches");
      const question = await h.waitFor(
        () => h.fake.sent("main").find((entry) => entry.text.includes("Clean system caches")),
        25_000,
        "the sudo approval question",
      );
      const sessionId = (await h.client.request("sessions.list"))[0].id;
      h.fake.inject("main", {
        update_id: 701,
        callback_query: {
          id: "callback-sudo-deny",
          from: { id: 100, is_bot: false, username: "owner" },
          message: {
            message_id: question.messageId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 100, type: "private" },
            text: "Clean system caches",
          },
          data: "q:" + sessionId + ":1",
        },
      });
      await h.waitFor(
        () =>
          h.fake.edits("main").find((entry) => entry.text.includes("not cleaned")) ??
          h.fake.sent("main").find((entry) => entry.text.includes("not cleaned")),
        25_000,
        "the denial answer",
      );
      await sleep(300);
      const log = await readFile(resolve(h.home, "logs/daemon.log"), "utf8").catch(() => "");
      assert.ok(!log.includes("sudo.run"), "a denied command never runs");
      assert.ok(log.includes("sudo.denied"), "the denial is logged");
    } finally {
      await h.stop();
    }
  },
};
