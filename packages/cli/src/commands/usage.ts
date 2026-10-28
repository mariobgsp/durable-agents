import { type Parsed, flag, has } from "../args.ts";
import { json, paint, print, table } from "../output.ts";
import { withDaemon } from "../client.ts";

type Numbers = { turns: number; tokens: number; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number };
type Report = {
  generatedAt: number;
  totals: Numbers & { sessions: number; toolCalls: number };
  periods: Record<string, Numbers>;
  agents: { id: string; name: string; all: Numbers; today: Numbers; month: Numbers }[];
  models: (Numbers & { provider: string; modelId: string })[];
  tools: { name: string; calls: number; errors: number; avgMs: number }[];
};

export async function runUsage(parsed: Parsed): Promise<void> {
  const period = flag(parsed, "period") ?? "today";
  const report = await withDaemon((client) => client.request<Report>("usage.report"));
  if (has(parsed, "json")) {
    json(report);
    return;
  }
  const selected = report.periods[period] ?? report.periods["today"];
  print(paint("bold", "usage · " + period));
  if (selected) {
    print(
      "turns " + selected.turns +
      " · tokens " + selected.tokens.toLocaleString("en-US") +
      " (in " + selected.input.toLocaleString("en-US") +
      ", out " + selected.output.toLocaleString("en-US") +
      ", cached " + selected.cacheRead.toLocaleString("en-US") + ")" +
      (selected.cost > 0 ? " · $" + selected.cost.toFixed(4) : ""),
    );
  }
  print("");
  table(
    ["agent", "today tokens", "month tokens", "all tokens"],
    report.agents.map((agent) => [
      agent.name + " (" + agent.id + ")",
      String(agent.today.tokens),
      String(agent.month.tokens),
      String(agent.all.tokens),
    ]),
  );
  if (report.models.length > 0) {
    print("");
    table(["model", "tokens", "turns"], report.models.map((model) => [model.provider + "/" + model.modelId, String(model.tokens), String(model.turns)]));
  }
}
