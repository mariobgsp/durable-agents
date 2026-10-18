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
export const credentialsPath = resolve(dataDir, "credentials.json");
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
