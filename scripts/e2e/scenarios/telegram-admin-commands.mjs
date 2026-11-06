import assert from "node:assert/strict";
import { startHarness } from "../harness.mjs";

export default {
  name: "telegram-admin-commands",
  async run() {
    const h = await startHarness({ agents: [{ id: "helper", name: "Helper" }] });
    try {
      h.text("main", 100, "/help");
      await h.waitFor(
        () => h.fake.sent("main").find((message) => message.text.includes("Commands")),
        15_000,
        "the help reply",
      );

      h.text("main", 100, "/mcp");
      await h.waitFor(
        () => h.fake.sent("main").find((message) => message.text.includes("No MCP servers")),
        15_000,
        "the MCP usage reply",
      );

      h.text("main", 100, "/reload");
      await h.waitFor(
        () => h.fake.sent("main").find((message) => message.text.includes("Reloaded") && message.text.includes("Bot commands resynced")),
        25_000,
        "the reload reply",
      );

      h.text("main", 100, "/model");
      await h.waitFor(
        () => h.fake.sent("main").find((message) => message.text.includes("this thread") && message.text.includes("default")),
        15_000,
        "the model reply",
      );

      h.text("main", 100, "/restart");
      const confirmation = await h.waitFor(
        () => h.fake.sent("main").find((message) => message.text.includes("Restart the service?")),
        15_000,
        "the restart confirmation",
      );
      assert.ok(confirmation.replyMarkup?.inline_keyboard?.length > 0, "restart asks for confirmation");
      assert.ok(
        JSON.stringify(confirmation.replyMarkup).includes("svc:restart"),
        "the confirmation carries the restart callback",
      );

      const before = (await h.client.request("sessions.list")).length;
      h.text("main", 100, "/new Groceries");
      const created = await h.waitFor(
        () => h.fake.sent("main").find((message) => message.text.includes("New thread #")),
        15_000,
        "the new-thread confirmation",
      );
      const sessions = await h.client.request("sessions.list");
      assert.equal(sessions.length, before + 1, "the new thread became a durable session");
      const fresh = sessions.find((session) => session.title === "Groceries");
      assert.ok(fresh, "the thread keeps the title given to /new");
      assert.ok(created.text.includes("#" + fresh.id), "the confirmation names the thread id");
      assert.ok(created.text.includes("agent helper"), "the confirmation names the agent");
      assert.ok(created.text.includes("/threads"), "the confirmation points at /threads");
    } finally {
      await h.stop();
    }
  },
};
