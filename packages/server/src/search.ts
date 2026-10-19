import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

/**
 * Web search without MCP and without a credential.
 *
 * pi-ai has no provider-native search, so this uses DuckDuckGo's keyless HTML endpoint over the built-in fetch and
 * parses the result page. That is a shape dependency, not an API: when the page or its markup changes, the tool says
 * so instead of pretending the query had no results. The provider is named in every result for the same reason.
 */
export const SEARCH_PROVIDER = "DuckDuckGo (HTML endpoint)";
const ENDPOINT = "https://html.duckduckgo.com/html/";
const MAX_RESULTS = 8;
// The endpoint answers a plain non-browser agent; a browser string would be a lie about who is asking.
const USER_AGENT = "durable-agents/1.0";
/** DuckDuckGo's own marker for a query with nothing to show, as opposed to a page it could not render. */
const NO_RESULTS = /class="[^"]*\bno-results\b/;

export type SearchHit = { title: string; url: string; snippet: string };
export type SearchReport = { ok: true; hits: SearchHit[] } | { ok: false; reason: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the entities DuckDuckGo emits in titles and snippets (named, decimal and hex). */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** Visible text of one HTML fragment: tags dropped (DuckDuckGo wraps matched terms in `<b>`), whitespace collapsed. */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** An href from the page: direct, protocol-relative, or wrapped in DuckDuckGo's `uddg` redirect. */
function resultUrl(href: string): string | undefined {
  const decoded = decodeEntities(href);
  try {
    const parsed = new URL(decoded.startsWith("//") ? "https:" + decoded : decoded, ENDPOINT);
    const target = parsed.searchParams.get("uddg");
    if (target) return target;
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function attribute(attributes: string, name: string): string | undefined {
  return new RegExp("\\b" + name + "\\s*=\\s*\"([^\"]*)\"", "i").exec(attributes)?.[1];
}

/** Title links of the result list, in page order. */
function parseResults(html: string): SearchHit[] {
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((match) => ({
    attributes: match[1] ?? "",
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    title: match[2] ?? "",
  }));
  const results: SearchHit[] = [];
  const resultAnchors = anchors.filter((anchor) =>
    (attribute(anchor.attributes, "class")?.split(/\s+/) ?? []).includes("result__a"),
  );
  for (const [index, anchor] of resultAnchors.entries()) {
    const href = attribute(anchor.attributes, "href");
    const url = href === undefined ? undefined : resultUrl(href);
    if (url === undefined) continue;
    // The snippet follows its title link and precedes the next result, and is an anchor with its own class.
    const scope = html.slice(anchor.end, resultAnchors[index + 1]?.start ?? html.length);
    const snippet = /<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(scope)?.[1] ?? "";
    results.push({ title: textOf(anchor.title), url, snippet: textOf(snippet) });
  }
  return results;
}

/** Search one query. Failures are values, so the tool can report them without throwing away the reason. */
export async function searchWeb(query: string): Promise<SearchReport> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return { ok: false, reason: "the query is empty." };
  const url = ENDPOINT + "?q=" + encodeURIComponent(trimmed);
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "text/html,application/xhtml+xml", "user-agent": USER_AGENT } });
  } catch (error) {
    return { ok: false, reason: `${SEARCH_PROVIDER} could not be reached: ${messageOf(error)}` };
  }
  if (response.status === 429) {
    return { ok: false, reason: `${SEARCH_PROVIDER} rate-limited the request (HTTP 429); try again later.` };
  }
  if (!response.ok) return { ok: false, reason: `${SEARCH_PROVIDER} answered HTTP ${response.status}.` };
  let html: string;
  try {
    html = await response.text();
  } catch (error) {
    return { ok: false, reason: `${SEARCH_PROVIDER} response could not be read: ${messageOf(error)}` };
  }
  if (NO_RESULTS.test(html)) return { ok: true, hits: [] };
  const hits = parseResults(html);
  if (hits.length === 0) {
    return {
      ok: false,
      reason: `${SEARCH_PROVIDER} returned no recognizable results, so its markup may have changed.`,
    };
  }
  return { ok: true, hits: hits.slice(0, MAX_RESULTS) };
}

/** What the model reads: the provider, then one numbered block per result. */
export function formatSearchReport(query: string, hits: readonly SearchHit[]): string {
  if (hits.length === 0) return `No results from ${SEARCH_PROVIDER} for "${query}".`;
  const lines = [`${SEARCH_PROVIDER} — ${hits.length} result${hits.length === 1 ? "" : "s"} for "${query}":`];
  for (const [index, hit] of hits.entries()) {
    lines.push(`${index + 1}. ${hit.title}`, `   ${hit.url}`);
    if (hit.snippet.length > 0) lines.push(`   ${hit.snippet}`);
  }
  return lines.join("\n");
}

export const webSearchTool = defineTool({
  name: "web-search",
  description:
    "Search the public web through DuckDuckGo's keyless HTML endpoint for titles, URLs and snippets. A failure is " +
    "reported as a failure, never as an empty result list, so quote the error instead of assuming there was nothing.",
  parameters: Type.Object({
    query: Type.String({ description: "What to search for." }),
  }),
  async execute(args) {
    const report = await searchWeb(args.query);
    if (!report.ok) {
      return { output: [{ type: "text" as const, text: `Web search failed: ${report.reason}` }], isError: true };
    }
    return { output: [{ type: "text" as const, text: formatSearchReport(args.query.trim(), report.hits) }] };
  },
});
