import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

export default {
  name: "command-scopes",
  async run() {
    const h = await startHarness({ agents: [{ id: "helper", name: "Helper" }] });
    try {
      // Boot sync runs before readiness; give the last set a moment.
      await h.waitFor(() => h.fake.commandSets("main").length >= 4, 10_000, "four command scopes set");
      const sets = h.fake.commandSets("main");
      const privateSet = sets.find((entry) => entry.scope?.type === "all_private_chats");
      assert.ok(privateSet, "private scope set");
      const names = privateSet.commands.map((command) => command.command);
      for (const required of ["menu", "new", "threads", "plan", "model", "usage", "reload", "restart"]) {
        assert.ok(names.includes(required), required + " is in the private menu");
      }
      const groupSet = sets.find((entry) => entry.scope?.type === "all_group_chats");
      assert.ok(groupSet, "group scope set");
      assert.ok(groupSet.commands.map((command) => command.command).includes("plan"), "plan is available in groups");
      const deletes = h.fake.commandDeletes("main");
      for (const type of ["default", "all_private_chats", "all_group_chats", "all_chat_administrators"]) {
        assert.ok(deletes.some((entry) => (entry.scope?.type ?? "default") === type), type + " was cleared");
      }
      assert.equal(h.fake.menuButton("main")?.type, "commands", "the menu button is the command list");
    } finally {
      await h.stop();
    }
  },
};
