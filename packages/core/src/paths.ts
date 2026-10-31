import { homedir } from "node:os";
import { resolve } from "node:path";

const env = process.env;

/**
 * Every file this app owns lives under one home. The default is ~/.dura-file; DURA_HOME overrides
 * it, and PI_DATA_DIR is kept for one release so pre-migration scripts keep pointing at the same
 * directory.
 *
 * This module deliberately imports no config: the config file lives under the home resolved here,
 * so resolving the home must not depend on reading it.
 */
export const duraHome = env.DURA_HOME
  ? resolve(env.DURA_HOME)
  : env.PI_DATA_DIR
    ? resolve(env.PI_DATA_DIR)
    : resolve(homedir(), ".dura-file");

/** The historical name for the same directory; modules that predate the rename still use it. */
export const dataDir = duraHome;

export const configPath = resolve(duraHome, "config.json");
export const credentialsPath = resolve(duraHome, "credentials.json");
export const secretsDir = resolve(duraHome, "secrets");
export const telegramBotsPath = resolve(secretsDir, "telegram.json");
/** MCP server definitions; commands and env may contain secrets, so the file is 0600. */
export const mcpPath = resolve(duraHome, "mcp.json");

export const dbPath = resolve(duraHome, "app.sqlite");
export const sessionsPath = resolve(duraHome, "sessions.json");
/** Directed agent-to-agent index: links and their answer status. Transcripts remain the source of truth. */
export const meshPath = resolve(duraHome, "mesh.json");
/** Per-agent cron schedules. */
export const schedulesPath = resolve(duraHome, "schedules.json");
/** Append-only spend from model calls that have no conversation of their own. */
export const usageLedgerPath = resolve(duraHome, "usage.jsonl");

export const vaultDir = resolve(duraHome, "vault");
export const vaultPath = resolve(vaultDir, "secrets.json");
export const vaultKeyPath = resolve(vaultDir, "key");
export const browserProfileDir = resolve(duraHome, "browser", "profile");
export const browserArtifactDir = resolve(duraHome, "browser", "shots");

/** The last system operation, written only at a terminal phase. */
export const systemPath = resolve(duraHome, "system.json");
/** The installed privileged-maintenance record, written by `dura sudo install`. */
export const sudoPath = resolve(duraHome, "sudo.json");
/** The restart handshake between the daemon and a supervisor (systemd or dura start --watch). */
export const restartSentinelPath = resolve(duraHome, "run", "restart-request");

export const logsDir = resolve(duraHome, "logs");
export const logPath = resolve(logsDir, "daemon.log");
export const runDir = resolve(duraHome, "run");
export const socketPath = resolve(runDir, "daemon.sock");
export const pidPath = resolve(runDir, "daemon.pid");
export const lockPath = resolve(runDir, "daemon.lock");
/** Written atomically at readiness so a detached start can find its child without a pipe. */
export const readyPath = resolve(runDir, "ready.json");

export const exportsDir = resolve(duraHome, "exports");
export const cacheDir = resolve(duraHome, "cache");
export const telegramDir = resolve(duraHome, "telegram");
export const telegramUsersPath = resolve(telegramDir, "users.json");
export const telegramStatePath = resolve(telegramDir, "state.json");
export const telegramTmpDir = resolve(telegramDir, "tmp");

/** Discord mirrors the Telegram layout, but only one of the two directories is read in a run. */
export const discordBotsPath = resolve(secretsDir, "discord.json");
export const discordDir = resolve(duraHome, "discord");
export const discordUsersPath = resolve(discordDir, "users.json");
export const discordStatePath = resolve(discordDir, "state.json");
export const discordWarningsPath = resolve(discordDir, "warnings.json");
export const discordTmpDir = resolve(discordDir, "tmp");

/** The repository root: where node_modules and the sources live. */
export const repoRoot = resolve(import.meta.dirname, "../../..");
/** Existing pi credentials; read only, never written. */
export const piAuthPath = resolve(env.HOME ?? homedir(), ".pi/agent/auth.json");
/**
 * Per-agent scratch space, inside the app home (PI_AGENT_TMP_DIR still moves it; the E2E harness
 * points it at its temp home).
 */
export const agentTmpRoot = env.PI_AGENT_TMP_DIR
  ? resolve(env.PI_AGENT_TMP_DIR)
  : resolve(duraHome, "tmp");
