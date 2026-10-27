import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { repoRoot, vaultDir, vaultKeyPath, vaultPath } from "./paths.ts";

/**
 * The encrypted half of the vault. No tool, no model import, no pi-durable dependency.
 *
 * This split is a memory decision as much as a layering one: the transcript imports this module to redact its
 * own output, and a transcript render must not drag the tool registry and the whole harness into the graph.
 * The tool that talks to the owner lives in vault-tool.ts and is loaded only when an agent asks for it.
 *
 * Three rules, none optional:
 * 1. Nothing is stored in clear. A 32-byte key lives beside the file, both are 0600 inside a 0700 directory,
 *    and the payload is AES-256-GCM, so a tampered file fails closed.
 * 2. Nothing is returned by a public shape. Every listing carries a fixed bullet mask, never a length or a
 *    prefix; the only reader is fillSecret(), which the browser tool uses to type into a page.
 * 3. Nothing is displayed. redactSecrets() masks every known value on the way out of the transcript.
 */

const ALGORITHM = "aes-256-gcm";
const MASK = "••••••";

type StoredEntry = {
  id: string;
  label: string;
  url?: string;
  iv: string;
  tag: string;
  ciphertext: string;
  createdAt: number;
  updatedAt: number;
};

type StoredFile = { version: 1; entries: StoredEntry[] };

/** What any caller outside this module may see. There is deliberately no plaintext field. */
export type PublicSecret = {
  id: string;
  label: string;
  url?: string;
  hasUsername: boolean;
  masked: typeof MASK;
  createdAt: number;
  updatedAt: number;
};

export type SecretInput = {
  label: string;
  username?: string;
  secret: string;
  url?: string;
  notes?: string;
};

/** A decrypted secret. Only the browser fill and the redactor use it; neither hands it to a model. */
export type RevealedSecret = { label: string; username: string; secret: string; notes: string; url?: string };

function ensureDir(): void {
  if (!existsSync(vaultDir)) mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
}

function key(): Buffer {
  ensureDir();
  if (!existsSync(vaultKeyPath)) {
    writeFileSync(vaultKeyPath, randomBytes(32), { mode: 0o600 });
    chmodSync(vaultKeyPath, 0o600);
  }
  const value = readFileSync(vaultKeyPath);
  if (value.length !== 32) {
    throw new Error("the vault key is damaged; restore data/vault/key from a backup instead of regenerating it");
  }
  chmodSync(vaultKeyPath, 0o600);
  return value;
}

function loadStore(): StoredFile {
  if (!existsSync(vaultPath)) return { version: 1, entries: [] };
  const parsed: unknown = JSON.parse(readFileSync(vaultPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as StoredFile).entries)) {
    throw new Error("the vault file is not a secrets store; refusing to overwrite it");
  }
  return parsed as StoredFile;
}

function saveStore(store: StoredFile): void {
  ensureDir();
  const temporary = vaultPath + ".tmp";
  writeFileSync(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, vaultPath);
  chmodSync(vaultPath, 0o600);
  cached = undefined;
}

function encrypt(payload: unknown): Pick<StoredEntry, "iv" | "tag" | "ciphertext"> {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: data.toString("base64"),
  };
}

type Payload = { username: string; secret: string; notes: string };

function decrypt(entry: StoredEntry): Payload {
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(entry.iv, "base64"));
  decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, "base64")), decipher.final()]);
  const parsed: unknown = JSON.parse(plain.toString("utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("a vault entry decrypted to an unexpected shape");
  const value = parsed as Partial<Payload>;
  return {
    username: typeof value.username === "string" ? value.username : "",
    secret: typeof value.secret === "string" ? value.secret : "",
    notes: typeof value.notes === "string" ? value.notes : "",
  };
}

function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "secret";
}

function publicOf(entry: StoredEntry): PublicSecret {
  let hasUsername = false;
  try {
    hasUsername = decrypt(entry).username.length > 0;
  } catch {
    // A damaged entry still lists: saying so is better than hiding that it exists.
    hasUsername = false;
  }
  return {
    id: entry.id,
    label: entry.label,
    ...(entry.url ? { url: entry.url } : {}),
    hasUsername,
    masked: MASK,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/** Store or replace one credential. Replacing keeps the id, so an open form does not lose its target. */
export function putSecret(input: SecretInput): PublicSecret {
  const label = input.label.trim().slice(0, 80);
  if (!label) throw new Error("a secret needs a label so it can be chosen later");
  if (!input.secret) throw new Error("a secret cannot be empty");
  const store = loadStore();
  const now = Date.now();
  const existing = store.entries.find((entry) => entry.label.toLowerCase() === label.toLowerCase());
  const encrypted = encrypt({
    username: (input.username ?? "").trim().slice(0, 320),
    secret: input.secret.slice(0, 4096),
    notes: (input.notes ?? "").slice(0, 2000),
  } satisfies Payload);
  const entry: StoredEntry = {
    id: existing?.id ?? slug(label) + "-" + randomBytes(3).toString("hex"),
    label,
    ...(input.url ? { url: input.url.slice(0, 2000) } : existing?.url ? { url: existing.url } : {}),
    ...encrypted,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  store.entries = existing
    ? store.entries.map((candidate) => (candidate.id === existing.id ? entry : candidate))
    : [...store.entries, entry];
  saveStore(store);
  return publicOf(entry);
}

/** Every credential, masked. This is what the API and the tool return. */
export function listSecrets(): PublicSecret[] {
  return loadStore()
    .entries.toSorted((a, b) => a.label.localeCompare(b.label))
    .map(publicOf);
}

export function deleteSecret(id: string): boolean {
  const store = loadStore();
  const next = store.entries.filter((entry) => entry.id !== id);
  if (next.length === store.entries.length) return false;
  saveStore({ ...store, entries: next });
  return true;
}

/** Resolve by id first, then by label, case-insensitively. Returns null rather than a reason that leaks ids. */
export function fillSecret(idOrLabel: string): RevealedSecret | null {
  const needle = idOrLabel.trim().toLowerCase();
  const entries = loadStore().entries;
  const entry =
    entries.find((candidate) => candidate.id === needle) ??
    entries.find((candidate) => candidate.label.toLowerCase() === needle);
  if (!entry) return null;
  const payload = decrypt(entry);
  return {
    label: entry.label,
    username: payload.username,
    secret: payload.secret,
    notes: payload.notes,
    ...(entry.url ? { url: entry.url } : {}),
  };
}

let cached: string[] | undefined;

/** Every plaintext value that must never appear in a rendered transcript, longest first. */
function redactionValues(): string[] {
  if (cached) return cached;
  const values = new Set<string>();
  try {
    for (const entry of loadStore().entries) {
      try {
        const payload = decrypt(entry);
        if (payload.secret.length >= 3) values.add(payload.secret);
        if (payload.username.length >= 3) values.add(payload.username);
      } catch {
        // A damaged entry must not stop the rest of the transcript from rendering.
      }
    }
  } catch {
    cached = [];
    return cached;
  }
  cached = [...values].toSorted((a, b) => b.length - a.length);
  return cached;
}

/**
 * Mask every known secret value in a string.
 *
 * Applied on the way out, not on the way in: the durable entry is the owner's own record, and rewriting it
 * would lose the fact that they said it. What matters is that no surface renders it, including the copy an
 * agent reads when it resumes a thread.
 */
export function redactSecrets(text: string): string {
  if (!text) return "";
  const values = redactionValues();
  if (values.length === 0) return text;
  let out = text;
  for (const value of values) {
    if (value.length < 3) continue;
    if (!out.includes(value)) continue;
    out = out.split(value).join(MASK);
    const encoded = encodeURIComponent(value);
    if (encoded !== value && out.includes(encoded)) out = out.split(encoded).join(MASK);
  }
  return out;
}

/** Whether git actually ignores the vault. Reported by the System panel; never fatal. */
export function vaultGitIgnored(): boolean | null {
  try {
    execFileSync("git", ["check-ignore", "-q", vaultPath], { cwd: repoRoot, timeout: 4000, stdio: "ignore" });
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { status?: unknown }).status === 1) return false;
    return null;
  }
}

export type VaultStatus = {
  path: string;
  count: number;
  keyPresent: boolean;
  gitIgnored: boolean | null;
  masked: typeof MASK;
};

export function vaultStatus(): VaultStatus {
  return {
    path: vaultPath,
    count: loadStore().entries.length,
    keyPresent: existsSync(vaultKeyPath),
    gitIgnored: vaultGitIgnored(),
    masked: MASK,
  };
}
