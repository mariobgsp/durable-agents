/**
 * Seed demo data so screenshots and manual checks have content without calling a model.
 * Run: npm run seed
 */
import type { Message } from "@earendil-works/pi-ai";
import { writeAgent } from "../src/agents.ts";
import { createSchedule } from "../src/schedules.ts";
import { context, openHarness } from "../src/harness.ts";
import { conversationOf, createSession } from "../src/sessions.ts";

type SeedEntry = { kind: string; data: { text: string; author?: string }; model?: Message[] };

const now = Date.now();
const diagramSource = `Here is the request flow.

\`\`\`mermaid
flowchart LR
  Browser[Browser] --> API[Fastify API]
  API --> DB[(SQLite)]
  API --> WS[WebSocket]
\`\`\`

The browser talks to one local process; the durable rows are the source of truth.`;

const diagramUser: Message = {
  role: "user",
  content: "Draw the request flow so I can see the pieces.",
  timestamp: now - 12_000,
};
const diagramAnswer: Message = {
  role: "assistant",
  api: "demo",
  provider: "demo",
  model: "demo-1",
  content: [{ type: "text", text: diagramSource }],
  usage: {
    input: 1_200,
    output: 800,
    cacheRead: 400,
    cacheWrite: 200,
    totalTokens: 2_600,
    cost: { input: 0.001, output: 0.0008, cacheRead: 0.0002, cacheWrite: 0.0001, total: 0.0021 },
  },
  stopReason: "stop",
  timestamp: now - 8_000,
  durationMs: 4_200,
};

const architect = await writeAgent({
  name: "Architect",
  tools: [],
  responsibility: "System design, request flow, and release documentation",
  color: "#7fb3d5",
  avatar: "🧭",
});
await writeAgent({
  name: "Chef",
  tools: [],
  responsibility: "Cooking, menus, and kitchen operations",
  color: "#e0a35c",
  avatar: "🧑‍🍳",
});
await writeAgent({
  name: "Scribe",
  tools: [],
  responsibility: "Documentation, release notes, and summaries",
  color: "#a2d5a2",
  avatar: "📝",
});
await writeAgent({
  name: "Sentinel",
  tools: [],
  responsibility: "Infrastructure, uptime, and incident response",
  color: "#d59a8f",
  avatar: "🛡️",
  enabled: false,
});
await createSchedule({
  agentId: architect.record.id,
  name: "Morning architecture brief",
  prompt: "Summarize the most important architectural risk and one next step.",
  cron: "0 9 * * 1-5",
});

const GROUPS: { title: string; agentId?: string; entries: SeedEntry[] }[] = [
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
  {
    title: "Request flow diagram",
    agentId: architect.record.id,
    entries: [
      {
        kind: "pi.user",
        data: { text: "Draw the request flow so I can see the pieces." },
        model: [diagramUser],
      },
      {
        kind: "pi.assistant",
        data: { text: "" },
        model: [diagramAnswer],
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
  const session = await createSession(group.title, group.agentId);
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