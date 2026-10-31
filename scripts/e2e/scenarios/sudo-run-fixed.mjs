import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
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

export default {
  name: "sudo-run-fixed",
  async run() {
    const h = await startHarness({
      script: [
        { toolCall: { name: "sudo", arguments: { action: "run", command: ["/bin/echo", "root"] } } },
        { text: "root is off" },
      ],
      agents: [{ id: "helper", name: "Helper" }],
    });
    try {
      await writeFile(resolve(h.home, "sudo.json"), JSON.stringify(CONFIG, null, 2) + "\n", { mode: 0o600 });
      h.text("main", 100, "run as root");
      await h.waitFor(
        () =>
          h.fake.edits("main").find((entry) => entry.text.includes("root is off")) ??
          h.fake.sent("main").find((entry) => entry.text.includes("root is off")),
        25_000,
        "the fixed-mode refusal answer",
      );
      assert.ok(
        !h.fake.sent("main").some((entry) => entry.text.includes("Run this command as root")),
        "fixed mode never asks to approve a root command",
      );
    } finally {
      await h.stop();
    }
  },
};
