import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startHarness } from "../harness.mjs";

export default {
  name: "orchestrator-claim-approval",
  async run() {
    const h = await startHarness({
      bots: [
        { label: "main", username: "mainbot", id: 1001, token: "1001:main" },
        { label: "helperbot", username: "helperbot", id: 1002, token: "1002:helper" },
      ],
      script: [
        { toolCall: { name: "orchestrator_claim" } },
        { text: "I asked the owner to approve." },
      ],
      agents: [
        { id: "orchestrator", name: "Orchestrator" },
        { id: "helper", name: "Helper", telegramBot: "helperbot" },
      ],
      orchestrator: "orchestrator",
    });
    try {
      h.text("helperbot", 100, "become the orchestrator");
      const approval = await h.waitFor(
        () => h.fake.sent("main").find((message) => message.text.includes("asks to become the orchestrator")),
        25_000,
        "the owner approval request",
      );
      assert.ok(JSON.stringify(approval.replyMarkup).includes("oc:helper"), "the approval carries the claim callback");

      h.fake.inject("main", {
        update_id: 701,
        callback_query: {
          id: "approve-helper",
          from: { id: 100, is_bot: false, username: "owner" },
          message: { message_id: approval.messageId, date: Math.floor(Date.now() / 1000), chat: { id: 100, type: "private" }, text: "approval" },
          data: "oc:helper",
        },
      });

      await h.waitFor(async () => {
        const config = JSON.parse(await readFile(resolve(h.home, "config.json"), "utf8"));
        return config.orchestrator.agentId === "helper";
      }, 15_000, "the owner approval to move the pointer");
    } finally {
      await h.stop();
    }
  },
};
