import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startHarness } from "../harness.mjs";

/**
 * The owner approves a cleanup: the question carries the detected OS, the commands and the size preview;
 * nothing runs before the button; the retried call executes and the result reaches the thread.
 */
const CONFIG = {
  version: 1,
  mode: "fixed",
  installedAt: 1,
  user: "e2e",
  os: { id: "fedora", name: "Fedora Linux 41 (Workstation Edition)", versionId: "41", family: "fedora" },
  manager: "dnf",
  probe: ["/usr/bin/sync"],
  cachePaths: ["/var/cache/dnf"],
  commands: {
    update: [["/usr/bin/dnf", "-y", "upgrade", "--refresh"]],
    cleanup: [
      ["/usr/bin/dnf", "clean", "all"],
      ["/usr/bin/journalctl", "--vacuum-size=200M"],
      ["/usr/bin/systemd-tmpfiles", "--clean"],
    ],
    memory: [
      ["/usr/bin/sync"],
      ["/usr/bin/sysctl", "-w", "vm.drop_caches=3"],
    ],
  },
};

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function readLog(home) {
  return readFile(resolve(home, "logs/daemon.log"), "utf8").catch(() => "");
}

export default {
  name: "sudo-cleanup",
  async run() {
    const h = await startHarness({
      script: [
        { toolCall: { name: "sudo", arguments: { action: "cleanup", reason: "e2e" } } },
        { text: "Waiting for approval." },
        { toolCall: { name: "sudo", arguments: { action: "cleanup", reason: "e2e" } } },
        { text: "cleanup finished" },
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
      assert.ok(question.replyMarkup?.inline_keyboard?.length > 0, "the approval has buttons");
      assert.ok(question.text.includes("Fedora Linux 41"), "the prompt carries the detected OS");
      assert.ok(question.text.includes("dnf clean all"), "the prompt carries the exact command");
      assert.ok(!(await readLog(h.home)).includes("sudo.run"), "nothing runs before approval");

      const sessions = await h.client.request("sessions.list");
      const sessionId = sessions[0].id;
      h.fake.inject("main", {
        update_id: 700,
        callback_query: {
          id: "callback-sudo-1",
          from: { id: 100, is_bot: false, username: "owner" },
          message: {
            message_id: question.messageId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 100, type: "private" },
            text: "Clean system caches",
          },
          data: "q:" + sessionId + ":0",
        },
      });

      await h.waitFor(
        () =>
          h.fake.edits("main").find((entry) => entry.text.includes("cleanup finished")) ??
          h.fake.sent("main").find((entry) => entry.text.includes("cleanup finished")),
        25_000,
        "the final answer",
      );
      let log = "";
      for (let index = 0; index < 100; index += 1) {
        log = await readLog(h.home);
        if (log.includes("sudo.run")) break;
        await sleep(100);
      }
      assert.ok(log.includes("sudo.run"), "the approved run is logged");
      assert.ok(log.includes("\"e2e\":true"), "the run is marked as the E2E simulation");
    } finally {
      await h.stop();
    }
  },
};
