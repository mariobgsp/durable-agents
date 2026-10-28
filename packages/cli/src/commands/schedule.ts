import { type Parsed, flag, has } from "../args.ts";
import { fail, json, paint, print, table } from "../output.ts";
import { withDaemon } from "../client.ts";

type Schedule = {
  id: string;
  agentId: string;
  name: string;
  cron: string;
  enabled: boolean;
  nextRunAt?: number;
  lastStatus?: string;
  lastRunAt?: number;
};

export async function runSchedule(parsed: Parsed): Promise<void> {
  const [action = "list", target] = parsed.positional;

  if (action === "list") {
    const schedules = await withDaemon((client) => client.request<Schedule[]>("schedules.list"));
    if (has(parsed, "json")) {
      json(schedules);
      return;
    }
    if (schedules.length === 0) {
      print("no schedules");
      return;
    }
    table(
      ["id", "agent", "name", "cron", "next", "state"],
      schedules.map((schedule) => [
        schedule.id.slice(0, 8),
        schedule.agentId,
        schedule.name,
        schedule.cron,
        schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : "-",
        schedule.enabled ? schedule.lastStatus ?? "enabled" : "paused",
      ]),
    );
    return;
  }

  if (action === "create") {
    const agentId = flag(parsed, "agent") ?? fail("usage: dura schedule create --agent <id> --name <name> --cron <expr> --prompt <text>", 2);
    const name = flag(parsed, "name") ?? "Schedule";
    const cron = flag(parsed, "cron") ?? fail("--cron is required (5 fields)", 2);
    const prompt = flag(parsed, "prompt") ?? fail("--prompt is required", 2);
    const schedule = await withDaemon((client) =>
      client.request<Schedule>("schedules.create", { input: { agentId, name, cron, prompt, enabled: !has(parsed, "paused") } }),
    );
    if (has(parsed, "json")) json(schedule);
    else print(paint("green", "created") + " " + schedule.id + " · next " + (schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : "-"));
    return;
  }

  if (action === "delete") {
    const id = target ?? fail("usage: dura schedule delete <id>", 2);
    const ok = await withDaemon((client) => client.request<boolean>("schedules.delete", { id }));
    print(ok ? "deleted " + id : "not found: " + id);
    return;
  }

  if (action === "run") {
    const id = target ?? fail("usage: dura schedule run <id>", 2);
    const result = await withDaemon((client) => client.request<Record<string, unknown>>("schedules.run", { id }));
    if (has(parsed, "json")) json(result);
    else print(JSON.stringify(result));
    return;
  }

  if (action === "pause" || action === "resume") {
    const id = target ?? fail("usage: dura schedule " + action + " <id>", 2);
    const schedule = await withDaemon((client) =>
      client.request<Schedule>("schedules.update", { id, patch: { enabled: action === "resume" } }),
    );
    print(schedule.name + " " + (schedule.enabled ? "resumed" : "paused"));
    return;
  }

  fail("usage: dura schedule <list|create|delete|run|pause|resume>", 2);
}
