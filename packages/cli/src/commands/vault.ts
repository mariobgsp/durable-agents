import { type Parsed, flag, has } from "../args.ts";
import { fail, json, paint, print, table } from "../output.ts";
import { deleteSecret, listSecrets, putSecret, vaultStatus } from "../../../core/src/vault-store.ts";
import { secret, ask } from "../prompts.ts";

export async function runVault(parsed: Parsed): Promise<void> {
  const [action = "list", target] = parsed.positional;

  if (action === "list") {
    const status = vaultStatus();
    const entries = listSecrets();
    if (has(parsed, "json")) {
      json({ status, entries });
      return;
    }
    print(paint("dim", "vault " + status.masked + " · " + status.count + " secrets · key " + (status.keyPresent ? "present" : "missing")));
    table(
      ["id", "label", "username", "updated"],
      entries.map((entry) => [entry.id.slice(0, 8), entry.label, entry.hasUsername ? "yes" : "-", new Date(entry.updatedAt).toLocaleDateString()]),
    );
    return;
  }

  if (action === "set") {
    const label = target ?? fail("usage: dura vault set <label> [--username x] [--url x]", 2);
    const username = flag(parsed, "username") ?? "";
    const url = flag(parsed, "url");
    const value = await secret("Secret value for " + label);
    if (!value) fail("empty secret", 2);
    const entry = putSecret({ label, username, secret: value, ...(url ? { url } : {}) });
    if (has(parsed, "json")) json(entry);
    else print(paint("green", "stored") + " " + label + " (" + entry.id.slice(0, 8) + ")");
    return;
  }

  if (action === "delete") {
    const id = target ?? fail("usage: dura vault delete <id>", 2);
    const ok = deleteSecret(id);
    print(ok ? "deleted" : "not found");
    return;
  }

  fail("usage: dura vault <list|set|delete>", 2);
}
