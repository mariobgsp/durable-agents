import { type Parsed, flag, has } from "../args.ts";
import { bytes, fail, json, paint, print, table } from "../output.ts";
import { withDaemon } from "../client.ts";

type Report = Record<string, number>;

function reportRows(report: Report): string[][] {
  return Object.entries(report)
    .filter(([key]) => key !== "totalBytes")
    .map(([key, value]) => [key.replace(/Bytes$/, ""), bytes(value)]);
}

export async function runStorage(parsed: Parsed): Promise<void> {
  const [action = "report", target] = parsed.positional;

  if (action === "report") {
    const report = await withDaemon((client) => client.request<Report>("storage.report"));
    if (has(parsed, "json")) {
      json(report);
      return;
    }
    table(["area", "size"], reportRows(report));
    print("");
    print(paint("bold", "total") + " " + bytes(report.totalBytes ?? 0));
    return;
  }

  if (action === "cleanup") {
    const result = await withDaemon((client) => client.request<Record<string, unknown>>("storage.cleanup"));
    const reclaimed = Number(result.reclaimedBytes ?? 0);
    if (has(parsed, "json")) json(result);
    else print(paint("green", "reclaimed") + " " + bytes(reclaimed));
    return;
  }

  if (action === "purge") {
    const id = target ?? fail("usage: dura storage purge <session-id> --yes", 2);
    if (!has(parsed, "yes")) fail("purge is irreversible; pass --yes and the session id", 4);
    const result = await withDaemon((client) => client.request<Record<string, unknown>>("sessions.purge", { id }));
    if (has(parsed, "json")) json(result);
    else print(paint("yellow", "purged") + " " + id + " (export written first)");
    return;
  }

  fail("usage: dura storage <report|cleanup|purge>", 2);
}
