/**
 * Generated-file E2E: create_file (text, JSON, base64), create_pdf and publish_file all attach a durable
 * download card; the route serves exactly the bytes that were saved.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export default {
  name: "files",
  async run(server) {
    const agent = await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "File agent", tools: [] }),
    });
    assert.equal(agent.status, 200);
    const agentId = agent.body.record.id;
    const thread = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "File output", agentId }),
    });
    const id = String(thread.body.id);

    const entries = async () => (await server.api("/api/sessions/" + id + "/messages")).body.entries;
    const waitFile = async (predicate) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const hit = (await entries()).find(
          (entry) => entry.role === "assistant" && entry.artifacts?.length > 0 && predicate(entry),
        );
        if (hit) return hit;
        await sleep(100);
      }
      throw new Error("no generated-file entry; saw " + JSON.stringify(await entries()));
    };
    const download = async (entry, artifact) => {
      const response = await fetch(
        server.base +
          "/api/sessions/" +
          id +
          "/files/" +
          entry.id +
          "/" +
          artifact.id +
          "?token=" +
          encodeURIComponent(server.token),
      );
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        disposition: response.headers.get("content-disposition"),
        bytes: Buffer.from(await response.arrayBuffer()),
      };
    };

    // 1. Markdown.
    await server.script([
      { toolCall: { name: "create_file", arguments: { name: "notes.md", content: "# Notes\n\nA durable file." } } },
      { text: "notes made" },
    ]);
    await server.send(id, { text: "make notes", requestId: "files-md" });
    await server.waitForEntry(id, (entry) => entry.role === "assistant" && entry.text === "notes made");
    const md = await waitFile((entry) => entry.artifacts[0].name === "notes.md");
    const mdFile = md.artifacts[0];
    assert.equal(mdFile.mimeType, "text/markdown; charset=utf-8");
    assert.ok(mdFile.bytes > 0);
    const mdBytes = await download(md, mdFile);
    assert.equal(mdBytes.status, 200);
    assert.match(mdBytes.contentType ?? "", /text\/markdown/);
    assert.match(mdBytes.disposition ?? "", /notes\.md/);
    assert.equal(mdBytes.bytes.toString("utf8"), "# Notes\n\nA durable file.");

    // 2. JSON and arbitrary base64 bytes.
    await server.script([
      {
        toolCall: {
          name: "create_file",
          arguments: { name: "data.json", content: JSON.stringify({ ok: true, n: 3 }), mimeType: "application/json" },
        },
      },
      { text: "json made" },
    ]);
    await server.send(id, { text: "make json", requestId: "files-json" });
    await server.waitForEntry(id, (entry) => entry.role === "assistant" && entry.text === "json made");
    const json = await waitFile((entry) => entry.artifacts[0].name === "data.json");
    const jsonBytes = await download(json, json.artifacts[0]);
    assert.deepEqual(JSON.parse(jsonBytes.bytes.toString("utf8")), { ok: true, n: 3 });

    await server.script([
      {
        toolCall: {
          name: "create_file",
          arguments: { name: "blob.bin", content: Buffer.from([0, 1, 2, 255]).toString("base64"), encoding: "base64" },
        },
      },
      { text: "blob made" },
    ]);
    await server.send(id, { text: "make blob", requestId: "files-blob" });
    await server.waitForEntry(id, (entry) => entry.role === "assistant" && entry.text === "blob made");
    const blob = await waitFile((entry) => entry.artifacts[0].name === "blob.bin");
    const blobBytes = await download(blob, blob.artifacts[0]);
    assert.deepEqual([...blobBytes.bytes], [0, 1, 2, 255]);

    // 3. PDF, and the text is actually in the PDF.
    await server.script([
      {
        toolCall: {
          name: "create_pdf",
          arguments: {
            name: "brief.pdf",
            title: "Release brief",
            content: "# Release brief\n\n- Storage healthy\n- Menu ready\n\nThis is the body.",
          },
        },
      },
      { text: "pdf made" },
    ]);
    await server.send(id, { text: "make pdf", requestId: "files-pdf" });
    await server.waitForEntry(id, (entry) => entry.role === "assistant" && entry.text === "pdf made");
    const pdf = await waitFile((entry) => entry.artifacts[0].name === "brief.pdf");
    const pdfBytes = await download(pdf, pdf.artifacts[0]);
    assert.equal(pdfBytes.bytes.subarray(0, 5).toString("ascii"), "%PDF-");
    const extracted = execFileSync("pdftotext", ["-", "-"], { input: pdfBytes.bytes, encoding: "utf8" });
    assert.match(extracted, /Release brief/);
    assert.match(extracted, /Storage healthy/);

    // 4. publish_file copies a file the agent already has on disk.
    const local = resolve(process.cwd(), ".e2e-publish-test.txt");
    await writeFile(local, "published from disk\n", "utf8");
    try {
      await server.script([
        {
          toolCall: {
            name: "publish_file",
            arguments: { path: ".e2e-publish-test.txt", name: "published.txt" },
          },
        },
        { text: "published" },
      ]);
      await server.send(id, { text: "publish it", requestId: "files-publish" });
      await server.waitForEntry(id, (entry) => entry.role === "assistant" && entry.text === "published");
      const published = await waitFile((entry) => entry.artifacts[0].name === "published.txt");
      const publishedBytes = await download(published, published.artifacts[0]);
      assert.equal(publishedBytes.bytes.toString("utf8"), "published from disk\n");
    } finally {
      await rm(local, { force: true });
    }

    // 5. The data directory reports the generated bytes.
    const storage = await server.api("/api/storage");
    assert.ok(storage.body.storage.artifactBytes > 0, "artifacts should be measured on disk");
  },
};