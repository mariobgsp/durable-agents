/**
 * Seed demo data so screenshots and manual checks have content without calling a model.
 * Run: npm run seed
 */
import { context, openHarness } from "../src/harness.ts";
import { conversationOf, createSession } from "../src/sessions.ts";

type SeedEntry = { kind: string; data: { text: string; author?: string } };

const GROUPS: { title: string; entries: SeedEntry[] }[] = [
  {
    title: "Crew talks release",
    entries: [
      { kind: "demo.user", data: { text: "Our release slipped two days. What should we fix first?" } },
      {
        kind: "demo.assistant",
        data: {
          author: "pirate",
          text: "The blocker is the storage migration: it has not been tested on Node 26. The rest can wait. Proposal: tie the release to the migration and ship the rest in a smaller release.",
        },
      },
      {
        kind: "demo.assistant",
        data: {
          author: "chef",
          text: "Addition: release notes do not exist yet. If the migration lands today I can write them tomorrow morning.",
        },
      },
      { kind: "demo.user", data: { text: "Agreed, tie it to the migration. Who is on call tonight?" } },
      {
        kind: "demo.assistant",
        data: {
          author: "robot",
          text: "I am on call. I will watch the logs every 30 minutes and report any new error.",
        },
      },
    ],
  },
  { title: "Empty thread", entries: [] },
  {
    title: "Next quarter roadmap and how the teams split the work",
    entries: [
      { kind: "demo.user", data: { text: "Where do we start?" } },
    ],
  },
];

const harness = await openHarness();
const created: { id: string; title: string }[] = [];

for (const group of GROUPS) {
  const session = await createSession(group.title);
  const conversation = await conversationOf(session.id);
  if (conversation) {
    for (const entry of group.entries) {
      await conversation.submit({ type: "write", entry }, context);
    }
  }
  created.push({ id: session.id, title: session.title });
}

console.log("demo sessions:");
for (const session of created) console.log("  " + session.id + "  " + session.title);
await harness.close(context);
