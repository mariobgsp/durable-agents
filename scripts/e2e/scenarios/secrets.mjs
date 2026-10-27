/**
 * Vault E2E: a credential goes in through the masked form and never comes back out.
 *
 * The assertions are about what cannot be observed, which is the whole feature: no API response contains the
 * value, the files are 0600 inside a 0700 directory, and every transcript render is redacted even when the
 * owner pasted the secret into the chat before the vault existed.
 */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const SECRET = "correct-horse-battery-staple-42";
const USERNAME = "octo@example.com";

export default {
  name: "secrets",
  async run(server) {
    const created = await server.api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Vault test", tools: ["vault"] }),
    });
    assert.equal(created.status, 200, "creating the vault agent should succeed: " + JSON.stringify(created.body));
    const agentId = created.body.record.id;

    const session = await server.api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "Vault", agentId }),
    });
    assert.equal(session.status, 200);
    const id = String(session.body.id);

    // 1. The agent asks for a credential instead of asking the owner to type it in the chat.
    await server.script([
      { toolCall: { name: "vault", arguments: { action: "request", label: "GitHub", purpose: "Sign in to GitHub" } } },
      { text: "Waiting for the form." },
    ]);
    const posted = await server.send(id, { text: "please sign in to github" });
    assert.equal(posted.status, 200);

    const request = await server.waitForEntry(id, (entry) => entry.kind === "chat.secret-request");
    assert.equal(request.role, "assistant", "the request renders as the agent's own message");
    assert.equal(request.author, agentId);
    assert.equal(request.data.label, "GitHub");
    assert.match(request.text, /masked form/i, "the bubble must point at the form, not ask for a paste");
    assert.doesNotMatch(request.text, /password/i, "the request text must not invite a password into chat");

    // 2. The form posts to /api/vault. The response is masked and contains neither value.
    const saved = await server.api("/api/vault", {
      method: "POST",
      body: JSON.stringify({ label: "GitHub", username: USERNAME, secret: SECRET }),
    });
    assert.equal(saved.status, 200, "saving should succeed: " + JSON.stringify(saved.body));
    assert.equal(saved.body.masked, "••••••");
    assert.equal(saved.body.hasUsername, true, "the form can report that a username exists without showing it");

    const listing = await server.api("/api/vault");
    assert.equal(listing.status, 200);
    const raw = JSON.stringify(listing.body);
    assert.ok(!raw.includes(SECRET), "the vault API must never return the secret");
    assert.ok(!raw.includes(USERNAME), "the username is encrypted too; only its presence is reported");
    assert.equal(listing.body.status.count, 1);
    assert.equal(listing.body.status.keyPresent, true);

    // 3. On disk: encrypted, 0600, inside a 0700 directory. The ciphertext must not contain the value.
    const vaultDir = resolve(server.dataDir, "vault");
    const store = resolve(vaultDir, "secrets.json");
    const key = resolve(vaultDir, "key");
    assert.equal(statSync(vaultDir).mode & 0o777, 0o700, "the vault directory is private");
    assert.equal(statSync(store).mode & 0o777, 0o600, "the store is owner-only");
    assert.equal(statSync(key).mode & 0o777, 0o600, "the key is owner-only");
    const bytes = readFileSync(store, "utf8");
    assert.ok(!bytes.includes(SECRET), "the store is ciphertext, not the password");
    assert.ok(!bytes.includes(USERNAME), "the username is encrypted as part of the payload");

    // 4. A paste that predates the vault is still redacted on every read.
    await server.script([{ text: "Noted." }]);
    await server.send(id, { text: "my old password was " + SECRET + " if that helps" });
    const redacted = await server.waitForEntry(
      id,
      (entry) => entry.role === "user" && entry.text.includes("my old password was"),
    );
    assert.ok(redacted.text.includes("••••••"), "the known secret is masked: " + redacted.text);
    assert.ok(!redacted.text.includes(SECRET), "the transcript must not render the secret");

    // 5. Deleting removes it from the listing and from the redactor.
    const removed = await server.api("/api/vault/" + saved.body.id, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const after = await server.api("/api/vault");
    assert.equal(after.body.entries.length, 0);
  },
};
