import { resolve } from "node:path";

const env = process.env;

/**
 * All application state lives in one directory.
 * The default <repo>/data is derived from this file's location, not from cwd, so `npm run dev`
 * and `npm start` point at the same directory. The desktop shell passes PI_DATA_DIR.
 */
export const dataDir = env.PI_DATA_DIR
  ? resolve(env.PI_DATA_DIR)
  : resolve(import.meta.dirname, "../../../data");
export const tokenPath = resolve(dataDir, "token");
export const dbPath = resolve(dataDir, "app.sqlite");
export const sessionsPath = resolve(dataDir, "sessions.json");
/** Directed agent-to-agent index: links and their answer status. The transcripts remain the source of truth. */
export const meshPath = resolve(dataDir, "mesh.json");
/** Per-agent cron schedules. */
export const schedulesPath = resolve(dataDir, "schedules.json");
/** Append-only spend from model calls that have no conversation of their own (Nyahut claims, suggestions). */
export const usageLedgerPath = resolve(dataDir, "usage.jsonl");
/** Global display/theme chosen by an agent or the owner. */
export const displayPath = resolve(dataDir, "display.json");
export const credentialsPath = resolve(dataDir, "credentials.json");
/**
 * The encrypted secret vault, its key, and the browser profile the owner's sessions live in.
 *
 * All three sit under data/, which .gitignore already excludes; the vault directory is also named
 * explicitly in .gitignore so a future change to the data rule cannot accidentally make it committable.
 */
export const vaultDir = resolve(dataDir, "vault");
export const vaultPath = resolve(vaultDir, "secrets.json");
export const vaultKeyPath = resolve(vaultDir, "key");
export const browserProfileDir = resolve(dataDir, "browser", "profile");
export const browserArtifactDir = resolve(dataDir, "browser", "shots");
/** The last system operation, written only at a terminal phase. The one writable file outside SQLite. */
export const systemPath = resolve(dataDir, "system.json");
/**
 * The dev supervisor's restart handshake. The server drops this file before exiting; `dev.mjs` sees it and
 * respawns the server child. A file, not an exit code: `node --watch` sits between dev.mjs and this process
 * and does not propagate the child's exit.
 */
export const restartSentinelPath = resolve(dataDir, "system", "restart-request");
/** The repository root: where `node_modules` and the web build live. */
export const repoRoot = resolve(import.meta.dirname, "../../..");
/** Existing pi credentials; read only, never written. */
export const piAuthPath = resolve(env.HOME ?? ".", ".pi/agent/auth.json");
/**
 * Per-agent scratch space: `~/tmp/<agent-id>`. A script an agent writes is easy to find and easy to delete,
 * and no agent has to invent its own corner of $HOME. `PI_AGENT_TMP_DIR` moves the root (the E2E harness
 * points it inside the test data directory, so a test never writes into the real home).
 */
export const agentTmpRoot = env.PI_AGENT_TMP_DIR
  ? resolve(env.PI_AGENT_TMP_DIR)
  : resolve(env.HOME ?? ".", "tmp");
export const serverPort = Number(env.PI_SERVER_PORT ?? 8787);
export const host = env.PI_HOST ?? "127.0.0.1";
export const configuredToken = env.PI_API_TOKEN ?? "";