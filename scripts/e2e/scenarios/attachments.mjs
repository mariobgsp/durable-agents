/**
 * Attachments E2E: one message carries its own files, the bytes live in the entry the model was given, and
 * a model that cannot see images is refused before anything is durable.
 *
 * Runs against the faux provider. `faux-vision` accepts images and `faux-text` does not, which is what makes
 * the pre-flight assertion deterministic; `echo: "images"` answers with the number of image blocks the model
 * was actually given, so the transport proof is the model's own view, not our claim about it.
 */
import assert from "node:assert/strict";
import { asAttachment, longText, pdf, png, pngSize } from "../fixtures/files.mjs";
import { startServer } from "../harness.mjs";

const DOC_CHAR_BUDGET = 40_000;

export default {
  name: "attachments",
  async run(server) {
    const create = async (title) => {
      const created = await server.api("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ title }),
      });
      assert.equal(created.status, 200, "creating a thread should succeed");
      return created.body.id;
    };
    const entriesOf = async (id) =>
      (await server.api("/api/sessions/" + id + "/messages")).body.entries;
    const lastUser = async (id) => {
      const entries = await entriesOf(id);
      const user = entries.filter((entry) => entry.role === "user").at(-1);
      assert.ok(user, "the thread should hold a user entry");
      return user;
    };

    // 1. An image reaches the model as a native block, not a placeholder.
    const vision = await create("Vision");
    const stream = server.ws(vision);
    await stream.ready;
    await stream.waitFor((frame) => frame.type === "snapshot");

    await server.script([{ echo: "images" }]);
    const posted = await server.send(vision, {
      text: "what is this?",
      requestId: "req-one",
      attachments: [asAttachment("dot.png", "image/png", png(64, 48))],
    });
    assert.equal(posted.status, 200, "posting an image should succeed: " + JSON.stringify(posted.body));
    const answer = await stream.waitFor((frame) => frame.type === "entry" && frame.entry.role === "assistant");
    assert.equal(answer.entry.text, "images: 1", "the model must receive one native image block");
    stream.close();

    // 2. The entry is the record: the request id, the file, and its metadata derived from the block.
    const first = await lastUser(vision);
    assert.equal(first.requestId, "req-one", "the entry echoes the request id, so an echo drops exactly once");
    assert.equal(first.files.length, 1, "one file should be described");
    assert.equal(first.files[0].name, "dot.png");
    assert.equal(first.files[0].kind, "image");
    assert.equal(first.files[0].state, "included");
    assert.equal(first.files[0].mimeType, "image/png");
    assert.ok(first.files[0].bytes > 0, "the byte size is derived from the block the model was given");

    // 3. The bytes come back out of that same entry.
    const served = await server.attachment(vision, first.id, 0);
    assert.equal(served.status, 200, "the attachment route should serve the file");
    assert.equal(served.contentType, "image/png");
    assert.match(served.cacheControl ?? "", /immutable/, "an immutable entry makes a cacheable URL");
    assert.equal(served.bytes.length, first.files[0].bytes, "the served bytes are the ones the model was given");
    assert.equal((await server.attachment(vision, first.id, 1)).status, 404, "an index past the last file is not found");

    // 4. Normalization, and the SQLite proof: the bytes live in the entry, and nowhere else.
    const big = await create("Big image");
    await server.script([{ text: "seen" }]);
    const upload = png(2000, 1500);
    await server.send(big, {
      text: "a photo",
      attachments: [asAttachment("big.png", "image/png", upload)],
    });
    const bigUser = await lastUser(big);
    assert.ok(
      bigUser.files[0].bytes < upload.length,
      "the stored image is the normalized one, not the upload: " +
        bigUser.files[0].bytes +
        " vs " +
        upload.length,
    );
    const normalized = await server.attachment(big, bigUser.id, 0);
    const size = pngSize(normalized.bytes);
    assert.ok(
      size.width <= 1568 && size.height <= 1568,
      "the image must fit the model's own limits, got " + JSON.stringify(size),
    );
    const rows = server.query("SELECT length(record) AS size FROM entries WHERE record LIKE '%big.png%'");
    assert.equal(rows.length, 1, "the user entry should be in SQLite");
    assert.ok(
      rows[0].size > 1_000_000,
      "the image bytes are inside the entry itself, not a pointer: record is " + rows[0].size + " bytes",
    );

    // 5. A message with no text at all still produces a bubble.
    const only = await create("Image only");
    await server.script([{ text: "ok" }]);
    const noText = await server.send(only, {
      text: "",
      requestId: "req-only",
      attachments: [asAttachment("only.png", "image/png", png(8, 8))],
    });
    assert.equal(noText.status, 200, "an image-only message should be accepted");
    const onlyUser = await lastUser(only);
    assert.equal(onlyUser.text, "", "the bubble has no text");
    assert.equal(onlyUser.files.length, 1, "but it still carries its file");
    assert.equal(onlyUser.requestId, "req-only");

    // 6. A model that cannot see images is refused before anything is durable or spent.
    const blind = await create("Blind");
    await server.api("/api/sessions/" + blind + "/model", {
      method: "PUT",
      body: JSON.stringify({ provider: "e2e", modelId: "faux-text" }),
    });
    const before = (await server.state()).body.callCount;
    const refused = await server.send(blind, {
      text: "look at this",
      attachments: [asAttachment("x.png", "image/png", png(8, 8))],
    });
    assert.equal(refused.status, 400, "an image for a text-only model must be refused");
    assert.equal(refused.body.code, "images_unsupported");
    assert.match(refused.body.error, /faux-text/, "the refusal names the model");
    assert.equal((await server.state()).body.callCount, before, "a refused message spends nothing");
    assert.deepEqual(await entriesOf(blind), [], "a refused message leaves nothing durable");

    // 7. A document becomes text in the prompt, and is served back as the text the model saw.
    await server.script([{ echo: "lastUser" }]);
    const notes = Buffer.from("# Notes\n\nunique-marker-42\n", "utf8");
    await server.send(blind, {
      text: "read this",
      attachments: [asAttachment("notes.md", "text/markdown", notes)],
    });
    const docAnswer = await server.waitForEntry(blind, (entry) => entry.role === "assistant");
    assert.match(docAnswer.text, /unique-marker-42/, "the model must read the document's text");
    assert.match(docAnswer.text, /File: notes\.md \(text\/markdown\)/, "the document arrives under its own header");
    const docUser = await lastUser(blind);
    assert.equal(docUser.files[0].kind, "document");
    assert.equal(docUser.files[0].state, "included");
    assert.ok(docUser.files[0].chars > 0, "the character count is derived from the block");
    const servedText = await server.attachment(blind, docUser.id, 0);
    assert.match(servedText.contentType ?? "", /text\/plain/);
    assert.match(servedText.bytes.toString("utf8"), /unique-marker-42/);

    // 8. Truncation is stated to the model and to the user with the same numbers.
    await server.script([{ text: "noted" }]);
    await server.send(blind, {
      text: "a long document",
      attachments: [asAttachment("long.txt", "text/plain", longText(200_000))],
    });
    const truncUser = await lastUser(blind);
    assert.equal(truncUser.files[0].state, "truncated", "an over-long document is marked as truncated");
    assert.equal(truncUser.files[0].code, "document-truncated");
    assert.equal(truncUser.files[0].chars, DOC_CHAR_BUDGET, "the model was given exactly the budget");
    const truncated = (await server.attachment(blind, truncUser.id, 0)).bytes.toString("utf8");
    assert.match(truncated, /\[truncated: the first 40,000 of 200,000 characters of long\.txt\]/);
    assert.ok(!truncated.includes("END-MARKER"), "the tail of the document was dropped, not the middle");

    // 9. A PDF is read through pdftotext.
    await server.script([{ echo: "lastUser" }]);
    await server.send(blind, {
      text: "a pdf",
      attachments: [asAttachment("paper.pdf", "application/pdf", pdf("Hello PDF"))],
    });
    const pdfAnswer = await server.waitForEntry(
      blind,
      (entry) => entry.role === "assistant" && /Hello PDF/.test(entry.text),
    );
    assert.match(pdfAnswer.text, /Hello PDF/, "the PDF's text reaches the model");
    const pdfUser = await lastUser(blind);
    assert.equal(pdfUser.files[0].state, "included");

    // 10. A group refuses attachments before it writes anything.
    await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Attach test", tools: [] }),
    });
    const room = await server.api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ title: "Attach room", members: ["attach-test"] }),
    });
    assert.equal(room.status, 200, "creating a group should succeed");
    const groupRefusal = await server.send(room.body.id, {
      text: "look",
      attachments: [asAttachment("x.png", "image/png", png(8, 8))],
    });
    assert.equal(groupRefusal.status, 400, "a group cannot take attachments");
    assert.equal(groupRefusal.body.code, "group_attachments");
    assert.deepEqual(await entriesOf(room.body.id), [], "a refused group message writes nothing");

    // 11. The budgets hold.
    const many = await server.send(vision, {
      text: "many files",
      attachments: Array.from({ length: 11 }, (_, index) =>
        asAttachment("f" + index + ".txt", "text/plain", Buffer.from("x", "utf8")),
      ),
    });
    assert.equal(many.status, 400, "eleven files is over the count budget");
    assert.equal(many.body.code, "too_many_files");
    const huge = Buffer.alloc(12 * 1024 * 1024 + 1, 0x41);
    const tooBig = await server.send(vision, {
      text: "huge file",
      attachments: [asAttachment("huge.txt", "text/plain", huge)],
    });
    assert.equal(tooBig.status, 413, "a file over the byte budget is refused");
    assert.equal(tooBig.body.code, "file_too_large");

    // 12. Both the entry and the bytes survive a restart, and a missing converter is a visible omission
    // rather than a failed message. The converter is pointed at nothing on purpose, so the branch is
    // deterministic instead of depending on whether this machine has poppler.
    const dataDir = server.dataDir;
    await server.stop({ keepData: true });
    // Reassigned deliberately: every helper above is bound to `server`, so the restarted instance takes its
    // place. run.mjs still stops the original object, which is what removes the shared data directory.
    server = await startServer({
      dataDir,
      env: { PI_PDFTOTEXT: "/nonexistent/pdftotext" },
    });

    const afterRestart = await lastUser(big);
    assert.equal(afterRestart.files.length, 1, "the transcript still describes the file after a restart");
    const afterBytes = await server.attachment(big, afterRestart.id, 0);
    assert.equal(afterBytes.status, 200, "the bytes are still served after a restart");
    assert.deepEqual(afterBytes.bytes, normalized.bytes, "and they are the same bytes, read from SQLite");

    await server.script([{ text: "noted" }]);
    const missing = await server.send(blind, {
      text: "a pdf without a converter",
      attachments: [asAttachment("paper.pdf", "application/pdf", pdf("Hello PDF"))],
    });
    assert.equal(missing.status, 200, "a PDF the server cannot read must not fail the whole message");
    const missingUser = await lastUser(blind);
    assert.equal(missingUser.files[0].state, "omitted");
    assert.equal(missingUser.files[0].code, "pdf-converter-missing");
    assert.match(missingUser.files[0].reason, /poppler/);

    await server.stop();
  },
};
