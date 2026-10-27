/**
 * Live browser E2E: one real headless launch, one page, then closed.
 *
 * The cheap scenario proves the lifecycle contract; this one proves the CDP path actually works and that the
 * agent can read a page through a tool result. It is skipped when no browser binary exists, because the app is
 * expected to run without one. A local page keeps the test offline and fast, and the explicit close is asserted
 * so a leaked chromium cannot hide behind a passing suite.
 */
import assert from "node:assert/strict";
import http from "node:http";

export default {
  name: "browser-live",
  async run(server) {
    const status = (await server.api("/api/browser")).body;
    if (!status.binary) {
      console.log("     (no browser binary on this machine; live launch skipped)");
      return;
    }

    const page = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        "<!doctype html><title>Live browser</title><h1>Hello from the live browser</h1><p>id=live-page</p>",
      );
    });
    await new Promise((done) => page.listen(0, "127.0.0.1", done));
    const port = page.address().port;

    try {
      const created = await server.api("/api/agents", {
        method: "POST",
        body: JSON.stringify({ name: "Browser test", tools: ["browser"] }),
      });
      assert.equal(created.status, 200, "creating the browser agent should succeed: " + JSON.stringify(created.body));
      const agentId = created.body.record.id;

      const session = await server.api("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ title: "Browser", agentId }),
      });
      assert.equal(session.status, 200);
      const id = String(session.body.id);

      await server.script([
        { toolCall: { name: "browser", arguments: { action: "open", url: "http://127.0.0.1:" + port + "/" } } },
        { text: "Opened the page." },
      ]);
      assert.equal((await server.send(id, { text: "open the local page" })).status, 200);

      const line = await server.waitForEntry(
        id,
        (entry) => entry.role === "tool" && entry.tool?.name === "browser",
        40_000,
      );
      assert.equal(line.tool.isError, false, "opening a local page should succeed: " + line.text);
      assert.match(line.text, /^URL: http:\/\/127\.0\.0\.1:/, "the trace line names the page it opened");

      // The rendered line is one line; the page text is in the durable record the model reads.
      const rows = server.query("SELECT record FROM entries WHERE record LIKE ?", "%Hello from the live browser%");
      assert.ok(rows.length > 0, "the tool result carries the page text");

      const running = (await server.api("/api/browser")).body;
      assert.equal(running.running, true, "the page action starts the browser");
      assert.equal(running.mode, "headless", "the default is headless");

      const closed = (await server.api("/api/browser/close", { method: "POST" })).body;
      assert.equal(closed.running, false, "close actually stops the process");
    } finally {
      page.close();
    }
  },
};
