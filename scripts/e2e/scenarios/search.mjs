/**
 * Search E2E: `web-search` parses a DuckDuckGo HTML page, and every failure reads as a failure.
 *
 * `fetch` is stubbed, so this proves the parser and the tool's honesty without a network call. The fixture is the
 * real page shape: result links carry DuckDuckGo's `uddg` redirect, titles and snippets contain entities and `<b>`
 * highlight tags, and a snippet is itself an anchor. The failure cases are the ones the tool must not disguise as
 * an empty result list: a rate limit, an unreadable page, and an unreachable provider.
 */
import assert from "node:assert/strict";

const FIXTURE = `<!DOCTYPE html>
<html><body>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a"
         href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbellard.org%2Fquickjs%2F&amp;rut=abc123">QuickJS &amp; the <b>sandbox</b></a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbellard.org%2Fquickjs%2F">A small
      embeddable <b>JavaScript</b> engine.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://example.com/quickjs-wasi">quickjs-wasi</a>
    </h2>
    <a class="result__snippet" href="https://example.com/quickjs-wasi">WebAssembly &amp; WASI build.</a>
  </div>
</div>
</body></html>`;

const NO_RESULTS = `<html><body><div class="no-results">No results.</div></body></html>`;

export default {
  name: "search",
  async run() {
    const { searchWeb, webSearchTool } = await import("../../../packages/server/src/search.ts");
    const realFetch = globalThis.fetch;
    const stub = (body, init) => {
      globalThis.fetch = async () => new Response(body, init);
    };
    const run = (query) => webSearchTool.execute({ query });
    try {
      // 1. A real-shaped page: provider named, redirect unwrapped, markup and entities cleaned.
      stub(FIXTURE, { status: 200, headers: { "content-type": "text/html" } });
      const report = await searchWeb("quickjs sandbox");
      assert.equal(report.ok, true, "a 200 page should parse");
      assert.equal(report.hits.length, 2, "both results should be found");
      assert.equal(report.hits[0].title, "QuickJS & the sandbox", "the title should lose tags and keep entities");
      assert.equal(
        report.hits[0].url,
        "https://bellard.org/quickjs/",
        "the DuckDuckGo redirect should resolve to the real URL",
      );
      assert.equal(report.hits[0].snippet, "A small embeddable JavaScript engine.");
      assert.equal(report.hits[1].url, "https://example.com/quickjs-wasi", "a direct URL should be kept");

      const result = await run("quickjs sandbox");
      assert.notEqual(result.isError, true, "a parsed page is not an error");
      const text = result.output[0].text;
      assert.match(text, /DuckDuckGo \(HTML endpoint\)/, "the tool must name its provider, got: " + text);
      assert.match(text, /2 results/, "the count should be visible");
      assert.match(text, /https:\/\/bellard\.org\/quickjs\//, "the model should get the real URL");
      assert.match(text, /A small embeddable JavaScript engine\./, "the model should get the snippet");

      // 2. A query with genuinely nothing is an empty answer, not an error.
      stub(NO_RESULTS, { status: 200 });
      const empty = await searchWeb("nothing matches this");
      assert.equal(empty.ok, true, "DuckDuckGo's own no-results marker is a real empty result");
      assert.deepEqual(empty.hits, []);

      // 3. Rate limit: the reason survives and the tool is an error, never an empty list.
      stub("rate limited", { status: 429 });
      const limited = await run("quickjs");
      assert.equal(limited.isError, true, "HTTP 429 must read as a failure");
      assert.match(limited.output[0].text, /rate-limited the request \(HTTP 429\)/, "got: " + limited.output[0].text);

      // 4. Shape drift: a page we cannot read is a failure, not "no results".
      stub("<html><body><p>something else entirely</p></body></html>", { status: 200 });
      const drifted = await run("quickjs");
      assert.equal(drifted.isError, true, "unrecognizable markup must read as a failure");
      assert.match(drifted.output[0].text, /markup may have changed/, "got: " + drifted.output[0].text);

      // 5. Unreachable: the network error is reported as itself.
      globalThis.fetch = async () => {
        throw new TypeError("fetch failed");
      };
      const unreachable = await run("quickjs");
      assert.equal(unreachable.isError, true, "a failed fetch must read as a failure");
      assert.match(unreachable.output[0].text, /could not be reached: fetch failed/, "got: " + unreachable.output[0].text);
    } finally {
      globalThis.fetch = realFetch;
    }
  },
};
