import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import WebSocket from "ws";
import { browserArtifactDir, browserProfileDir } from "./paths.ts";
import { fillSecret } from "./vault-store.ts";

/**
 * One browser, on demand: headless by default, headful when the owner asks, and shut down when idle.
 *
 * The constraints here are memory and sessions, and they pull in opposite directions. Sessions want a real
 * profile that survives restarts; memory wants no browser at all. The compromise is one profile, one process,
 * one tab, a small renderer limit, a capped V8 heap, and an idle timer that closes the process after a few
 * idle minutes — so an idle server costs nothing and the owner's logins still survive because they live in
 * the profile directory, not in the process.
 *
 * A login is filled from the vault and the typed values are never returned. The tool cannot read a password,
 * and the page text a model sees is redacted of every vault value before it is returned.
 */

const DEFAULT_IDLE_MS = 5 * 60_000;

/**
 * How long an idle browser is kept.
 *
 * Chromium is the largest resident cost on this machine (about 450 MB of PSS with one page open), and it is
 * only needed while a page action runs, so the window it is allowed to sit idle in is short and configurable:
 * `DURA_BROWSER_IDLE_SECONDS` (minimum 5, default 300) rather than a constant someone has to recompile.
 */
function configuredIdleMs(): number {
  const seconds = Number(process.env.DURA_BROWSER_IDLE_SECONDS ?? "");
  if (Number.isFinite(seconds) && seconds >= 5) return Math.round(seconds) * 1000;
  return DEFAULT_IDLE_MS;
}

const IDLE_MS = configuredIdleMs();
const LAUNCH_TIMEOUT_MS = 20_000;
const NAVIGATION_TIMEOUT_MS = 25_000;

/** "4m 30s", "45s": the idle window as the owner reads it, not as milliseconds. */
function idleLabel(): string {
  const total = Math.round(IDLE_MS / 1000);
  if (total < 60) return total + "s";
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? minutes + "m" : minutes + "m " + seconds + "s";
}

type Mode = "headless" | "headful";

type BrowserState = {
  /** Absent when the browser was adopted: it was already running, so this process holds no handle to it. */
  child?: ChildProcess;
  mode: Mode;
  port: number;
  profileDir: string;
  targetWs: string;
  cdp: Cdp;
  lastUsed: number;
  idleTimer?: NodeJS.Timeout;
};

/**
 * The browser belongs to the process, not to this module.
 *
 * The tool module can be loaded more than once in one process — a reloaded agent graph, a second copy of the
 * package — and a module-scoped `state` then hides a running browser from the copy that is asked to use it:
 * `status` answered "idle" for a chromium that was alive, `close` left it running, and every action spawned a
 * chromium that aborted on the profile lock (exit 21) and then attached to the previous browser's leftover
 * devtools port, abandoning one more tab per call. One holder on globalThis gives the whole process a single
 * browser, a single tab and a single lock.
 */
type BrowserHolder = {
  state?: BrowserState;
  starting?: Promise<BrowserState>;
  /**
   * One browser, one tab, one action at a time.
   *
   * pi-durable runs tools in parallel, and two page actions on the same tab would interleave navigations and
   * fills. The lock is a promise chain rather than a queue object: a failed action releases it in finally.
   */
  lock: Promise<void>;
};

const HOLDER_KEY = Symbol.for("dura.browser.holder");
const globalScope = globalThis as unknown as Record<symbol, BrowserHolder | undefined>;
const holder: BrowserHolder = (globalScope[HOLDER_KEY] ??= { lock: Promise.resolve() });

export type BrowserStatus = {
  running: boolean;
  mode?: Mode;
  pid?: number;
  port?: number;
  profileDir: string;
  binary: string | null;
  idleMinutes: number;
  /** Localised idle window, e.g. "5m" or "45s". */
  idleLabel: string;
};

/**
 * The user agent headless chromium should send.
 *
 * Headless chromium announces itself as `HeadlessChrome`, and sites that dislike automation answer that with a
 * bare 403 that looks exactly like a network block — x.com does, and the owner reads it as "the tool is
 * broken". Headful keeps its own user agent; headless gets the version of the binary that is really running.
 */
export function desktopUserAgent(binary: string): string {
  const fromEnv = process.env.PI_BROWSER_UA;
  if (fromEnv) return fromEnv;
  let major = "124";
  try {
    const printed = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 5000 });
    const found = /(\d+)\.\d+\.\d+\.\d+/.exec(printed);
    if (found?.[1]) major = found[1];
  } catch {
    // A binary that will not print a version still gets a plausible one.
  }
  const platform =
    process.platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : process.platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  return "Mozilla/5.0 (" + platform + ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + major + ".0.0.0 Safari/537.36";
}

/** Where the browser binary is. The environment wins, then the usual names on PATH. */
export function browserBinary(): string | null {
  const configured = process.env.PI_BROWSER_BIN;
  if (configured && existsSync(configured)) return configured;
  const names = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome", "brave"];
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = resolve(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

class Cdp {
  private socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly waiters = new Map<string, (value: unknown) => void>();
  private closed = false;

  constructor(url: string) {
    this.socket = new WebSocket(url, { perMessageDeflate: false });
    this.socket.on("message", (data) => {
      let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown };
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (typeof message.id === "number") {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message ?? "CDP error"));
        else entry.resolve(message.result);
        return;
      }
      if (message.method) {
        const waiter = this.waiters.get(message.method);
        if (waiter) {
          this.waiters.delete(message.method);
          waiter(message.params);
        }
      }
    });
    this.socket.on("close", () => {
      this.closed = true;
      for (const entry of this.pending.values()) entry.reject(new Error("the browser closed"));
      this.pending.clear();
    });
    this.socket.on("error", () => {
      // The close handler rejects in-flight calls; an unhandled error event would crash the process.
    });
  }

  async ready(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error("the browser devtools socket did not open")), 8000);
      this.socket.once("open", () => {
        clearTimeout(timer);
        done();
      });
      this.socket.once("error", (error) => {
        clearTimeout(timer);
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("the browser is closed"));
    const id = this.nextId++;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(method + " timed out"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          done(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          fail(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Resolve on the next occurrence of one event, or after the timeout. */
  once(method: string, timeoutMs: number): Promise<unknown> {
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.waiters.delete(method);
        done(undefined);
      }, timeoutMs);
      this.waiters.set(method, (value) => {
        clearTimeout(timer);
        done(value);
      });
    });
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

function portOpen(port: number): Promise<string> {
  return new Promise((done, fail) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/json/version", method: "GET", timeout: 2000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => done(body));
    });
    req.on("timeout", () => {
      req.destroy();
      fail(new Error("devtools did not answer"));
    });
    req.on("error", fail);
    req.end();
  });
}

async function waitForPort(port: number, deadline: number): Promise<void> {
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      await portOpen(port);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await new Promise((done) => setTimeout(done, 150));
    }
  }
  throw new Error("the browser did not expose devtools: " + (lastError?.message ?? "no answer"));
}

/** Create one page target and connect to it. */
async function openTarget(port: number): Promise<{ ws: string; cdp: Cdp }> {
  const created = await new Promise<{ webSocketDebuggerUrl?: string }>((done, fail) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/json/new?about:blank", method: "PUT", timeout: 5000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          try {
            done(JSON.parse(body));
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      fail(new Error("the browser did not create a tab"));
    });
    req.on("error", fail);
    req.end();
  });
  if (!created.webSocketDebuggerUrl) throw new Error("the browser created a tab without a devtools socket");
  return connectTarget(created.webSocketDebuggerUrl);
}

/** Attach to one page target and turn on the two domains the actions need. */
async function connectTarget(webSocketDebuggerUrl: string): Promise<{ ws: string; cdp: Cdp }> {
  const cdp = new Cdp(webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  return { ws: webSocketDebuggerUrl, cdp };
}

/** The port chromium writes after it starts. It outlives the process, so it is never trusted on its own. */
function devtoolsPortFile(): string {
  return resolve(browserProfileDir, "DevToolsActivePort");
}

function portFromFile(): number | undefined {
  try {
    const parsed = Number(readFileSync(devtoolsPortFile(), "utf8").split("\n")[0]?.trim() ?? "");
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function devtoolsJson(port: number, path: string, method = "GET"): Promise<unknown> {
  return new Promise((done, fail) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, timeout: 3000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        try {
          done(JSON.parse(body));
        } catch {
          fail(new Error("devtools answered with something that is not json"));
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      fail(new Error("devtools did not answer"));
    });
    req.on("error", fail);
    req.end();
  });
}

type TargetInfo = { id?: string; type?: string; url?: string; webSocketDebuggerUrl?: string };

/**
 * Drop the blank tab chromium opens on launch.
 *
 * The browser starts on `about:blank` and the tool then adds the tab it drives, so a running browser always
 * carried one extra page — and one extra renderer, around fifty megabytes — that nothing ever reads. Only blank
 * pages are closed here: a page the owner left open is never touched.
 */
async function closeBlankTabs(port: number, keepWs: string): Promise<void> {
  let listed: unknown;
  try {
    listed = await devtoolsJson(port, "/json/list");
  } catch {
    return;
  }
  if (!Array.isArray(listed)) return;
  for (const target of listed as TargetInfo[]) {
    if (target.type !== "page" || !target.id) continue;
    if (target.webSocketDebuggerUrl === keepWs) continue;
    if (target.url && target.url !== "about:blank") continue;
    try {
      await devtoolsText(port, "/json/close/" + target.id);
    } catch {
      // A tab that is already gone is exactly the outcome wanted.
    }
  }
}

/** The same devtools call, for endpoints that answer with plain text instead of json. */
function devtoolsText(port: number, path: string): Promise<string> {
  return new Promise((done, fail) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", timeout: 3000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => done(body));
    });
    req.on("timeout", () => {
      req.destroy();
      fail(new Error("devtools did not answer"));
    });
    req.on("error", fail);
    req.end();
  });
}

/**
 * Take over a chromium that is already running on this profile.
 *
 * A second launch cannot start a browser on a locked profile; it aborts and leaves the first one serving the
 * old devtools port. Adopting that browser is both correct and cheap: the page the owner opened stays, and no
 * process is spawned at all. The newest tab with a real URL is reused, so `open` → `read` → `click` chains
 * stay on one tab instead of piling up blank ones.
 */
async function adoptRunning(mode: Mode): Promise<BrowserState | undefined> {
  const port = portFromFile();
  if (!port) return undefined;
  try {
    await portOpen(port);
  } catch {
    return undefined;
  }
  let pages: TargetInfo[] = [];
  try {
    const listed = await devtoolsJson(port, "/json/list");
    if (Array.isArray(listed)) pages = (listed as TargetInfo[]).filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  } catch {
    pages = [];
  }
  const reusable = pages.find((target) => target.url && target.url !== "about:blank") ?? pages[0];
  const target = reusable?.webSocketDebuggerUrl ? await connectTarget(reusable.webSocketDebuggerUrl) : await openTarget(port);
  await closeBlankTabs(port, target.ws);
  return {
    mode: holder.state?.mode ?? mode,
    port,
    profileDir: browserProfileDir,
    targetWs: target.ws,
    cdp: target.cdp,
    lastUsed: Date.now(),
  };
}

/** Close a browser this process did not spawn: the only handle is the devtools endpoint. */
async function closeAdopted(port: number): Promise<void> {
  try {
    const version = (await devtoolsJson(port, "/json/version")) as { webSocketDebuggerUrl?: string };
    if (!version?.webSocketDebuggerUrl) return;
    const cdp = new Cdp(version.webSocketDebuggerUrl);
    await cdp.ready();
    await cdp.send("Browser.close", {}, 4000).catch(() => undefined);
    cdp.close();
  } catch {
    // Already gone.
  }
}

function armIdle(browser: BrowserState): void {
  if (browser.idleTimer) clearTimeout(browser.idleTimer);
  browser.idleTimer = setTimeout(() => {
    void closeBrowser();
  }, IDLE_MS);
  browser.idleTimer.unref?.();
}

export async function ensureBrowser(mode: Mode = "headless"): Promise<BrowserState> {
  if (holder.state && holder.state.mode === mode && !holder.state.child?.killed) {
    holder.state.lastUsed = Date.now();
    armIdle(holder.state);
    return holder.state;
  }
  if (holder.state) await closeBrowser();
  if (holder.starting) return holder.starting;

  holder.starting = (async () => {
    const adopted = await adoptRunning(mode);
    if (adopted) {
      holder.state = adopted;
      armIdle(adopted);
      return adopted;
    }
    const binary = browserBinary();
    if (!binary) {
      throw new Error(
        "no browser binary found. Install chromium (or set PI_BROWSER_BIN) and try again. " +
          "The tool stays off until then; nothing was started.",
      );
    }
    mkdirSync(browserProfileDir, { recursive: true, mode: 0o700 });
    chmodSync(browserProfileDir, 0o700);
    mkdirSync(browserArtifactDir, { recursive: true, mode: 0o700 });

    const args = [
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--user-data-dir=" + browserProfileDir,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--disable-translate",
      "--disable-features=Translate,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion,InterestFeedContentSuggestions",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--renderer-process-limit=1",
      "--process-per-site",
      "--disk-cache-size=33554432",
      "--window-size=1280,900",
      "--mute-audio",
      ...(mode === "headless" ? ["--headless=new", "--user-agent=" + desktopUserAgent(binary)] : []),
      "about:blank",
    ];
    // A port file left by an earlier browser points at a dead port, or at another browser's live one.
    try {
      unlinkSync(devtoolsPortFile());
    } catch {
      // Nothing to clear.
    }
    const child = spawn(binary, args, {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ":0" },
    });
    child.unref();
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    let port = 0;
    while (Date.now() < deadline) {
      const found = portFromFile();
      if (found) {
        port = found;
        break;
      }
      // A browser that aborts (a locked profile, a broken install) never writes the port; say so instead of
      // waiting out the whole deadline.
      if (child.exitCode !== null) break;
      await new Promise((done) => setTimeout(done, 120));
    }
    if (port === 0) {
      child.kill("SIGKILL");
      throw new Error(
        child.exitCode !== null
          ? "the browser exited before it opened devtools (the profile may be locked by another browser)"
          : "the browser started but never reported a devtools port",
      );
    }
    await waitForPort(port, deadline);
    const target = await openTarget(port);
    await closeBlankTabs(port, target.ws);
    const created: BrowserState = {
      child,
      mode,
      port,
      profileDir: browserProfileDir,
      targetWs: target.ws,
      cdp: target.cdp,
      lastUsed: Date.now(),
    };
    holder.state = created;
    armIdle(created);
    child.once("exit", () => {
      if (holder.state?.child === child) {
        holder.state = undefined;
        holder.starting = undefined;
      }
    });
    return created;
  })();

  try {
    return await holder.starting;
  } finally {
    holder.starting = undefined;
  }
}

export async function closeBrowser(): Promise<void> {
  if (!holder.state) return;
  const current = holder.state;
  holder.state = undefined;
  if (current.idleTimer) clearTimeout(current.idleTimer);
  current.cdp.close();
  if (!current.child) {
    // Adopted: there is no child handle, so the browser is asked to quit over devtools.
    await closeAdopted(current.port);
    return;
  }
  try {
    current.child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  // A browser that ignores SIGTERM is killed rather than left behind; the whole point is a flat idle cost.
  await new Promise((done) => setTimeout(done, 700));
  if (!current.child.killed && current.child.exitCode === null) {
    try {
      current.child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/**
 * Last-resort cleanup. The server closes the browser on SIGINT/SIGTERM, but a tool-installed module is loaded
 * through require(), which the route-level lazy import in index.ts cannot see. Killing the process group on exit
 * means a crash or a restart cannot leave an orphaned Chromium holding hundreds of megabytes.
 */
process.once("exit", () => {
  try {
    holder.state?.child?.kill("SIGKILL");
  } catch {
    // Already gone.
  }
});

export function browserStatus(): BrowserStatus {
  return {
    running: holder.state !== undefined,
    ...(holder.state
      ? { mode: holder.state.mode, pid: holder.state.child?.pid ?? undefined, port: holder.state.port }
      : {}),
    profileDir: browserProfileDir,
    binary: browserBinary(),
    idleMinutes: Math.round(IDLE_MS / 60_000),
    idleLabel: idleLabel(),
  };
}

function safeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("that is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http and https pages can be opened");
  }
  return url.toString();
}

async function evaluate(cdp: Cdp, expression: string, timeoutMs = 30_000): Promise<unknown> {
  const result = (await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  }, timeoutMs)) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "the page rejected the script");
  return result.result?.value;
}

function selectorJson(selector: string): string {
  return JSON.stringify(selector);
}

async function fill(cdp: Cdp, selector: string, value: string): Promise<void> {
  const script = [
    "(() => {",
    "  const el = document.querySelector(" + selectorJson(selector) + ");",
    "  if (!el) return 'missing';",
    "  el.focus();",
    "  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;",
    "  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;",
    "  if (setter) setter.call(el, " + JSON.stringify(value) + "); else el.value = " + JSON.stringify(value) + ";",
    "  el.dispatchEvent(new Event('input', { bubbles: true }));",
    "  el.dispatchEvent(new Event('change', { bubbles: true }));",
    "  return 'ok';",
    "})()",
  ].join("\n");
  const outcome = await evaluate(cdp, script);
  if (outcome !== "ok") throw new Error("no field matched " + selector);
}

/** Press Enter in whatever field has focus. */
async function pressEnter(cdp: Cdp): Promise<void> {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

async function navigate(cdp: Cdp, url: string): Promise<void> {
  const loaded = cdp.once("Page.loadEventFired", NAVIGATION_TIMEOUT_MS);
  await cdp.send("Page.navigate", { url }, NAVIGATION_TIMEOUT_MS);
  await loaded;
}

async function pageSummary(cdp: Cdp, limit = 6000): Promise<string> {
  const title = await evaluate(cdp, "document.title");
  const text = await evaluate(cdp, "document.body ? document.body.innerText : ''");
  const url = await evaluate(cdp, "location.href");
  const body = typeof text === "string" ? text.trim() : "";
  return [
    "URL: " + String(url),
    "Title: " + String(title),
    "",
    body.length > limit ? body.slice(0, limit) + "\n[… truncated]" : body,
  ].join("\n");
}

export const browserTool = defineTool({
  name: "browser",
  description:
    "Drive a real browser that keeps the owner's existing logins (one persistent profile). Headless by default, " +
    "headful on request. Actions: open, read, screenshot, click, type, login, close, status. The browser starts " +
    "only when a page action runs and closes itself after a short idle window; never leave it running for no " +
    "reason. login fills a username and password from the vault and returns only the resulting page, never the " +
    "values.",
  parameters: Type.Object({
    action: Type.Union([
      Type.Literal("open"),
      Type.Literal("read"),
      Type.Literal("screenshot"),
      Type.Literal("click"),
      Type.Literal("type"),
      Type.Literal("login"),
      Type.Literal("close"),
      Type.Literal("status"),
    ]),
    url: Type.Optional(Type.String({ description: "For open/login: the http(s) page." })),
    selector: Type.Optional(Type.String({ description: "For click/type: a CSS selector." })),
    text: Type.Optional(Type.String({ description: "For type: the text to enter (never a password; use login)." })),
    submit: Type.Optional(Type.Boolean({ description: "For type: press Enter after entering the text." })),
    vault: Type.Optional(Type.String({ description: "For login: the vault label or id holding the credentials." })),
    usernameSelector: Type.Optional(Type.String({ description: "For login: CSS selector of the email/username field." })),
    passwordSelector: Type.Optional(Type.String({ description: "For login: CSS selector of the password field." })),
    submitSelector: Type.Optional(Type.String({ description: "For login: CSS selector of the submit button." })),
    mode: Type.Optional(Type.Union([Type.Literal("headless"), Type.Literal("headful")])),
  }),
  async execute(args) {
    let release!: () => void;
    const previous = holder.lock;
    holder.lock = new Promise<void>((done) => (release = done));
    await previous;
    try {
      if (args.action === "status") {
        const status = browserStatus();
        return {
          output: [
            {
              type: "text" as const,
              text: status.running
                ? "Browser running (" + status.mode + ", pid " + (status.pid ?? "adopted") + ", closes after " + status.idleLabel + " idle)."
                : status.binary
                  ? "Browser idle. It starts on the first page action and closes after " + status.idleLabel + " idle."
                  : "No browser binary found. Install chromium or set PI_BROWSER_BIN.",
            },
          ],
        };
      }
      if (args.action === "close") {
        await closeBrowser();
        return { output: [{ type: "text" as const, text: "Browser closed; the profile is kept." }] };
      }

      const mode: Mode = args.mode === "headful" ? "headful" : "headless";
      const browser = await ensureBrowser(mode);
      browser.lastUsed = Date.now();
      armIdle(browser);
      const cdp = browser.cdp;

      if (args.action === "open") {
        const url = safeUrl(args.url ?? "");
        await navigate(cdp, url);
        return { output: [{ type: "text" as const, text: await pageSummary(cdp) }] };
      }

      if (args.action === "login") {
        const secret = fillSecret(args.vault ?? "");
        if (!secret) {
          return {
            output: [
              {
                type: "text" as const,
                text:
                  "No vault entry matched " + (args.vault ?? "(empty)") + ". Use the vault tool with action=request " +
                  "to ask the owner, then try again.",
              },
            ],
            isError: true,
          };
        }
        const url = safeUrl(args.url ?? secret.url ?? "");
        await navigate(cdp, url);
        const userSelector =
          args.usernameSelector ?? 'input[type="email"], input[name="email"], input[name="username"], input[autocomplete="username"]';
        const passSelector = args.passwordSelector ?? 'input[type="password"]';
        if (secret.username) await fill(cdp, userSelector, secret.username);
        // Two-step forms (x.com among them) ask for the name first and only then reveal the password field, so a
        // missing password field is a step to advance, not a failure.
        const passwordField = "Boolean(document.querySelector(" + selectorJson(passSelector) + "))";
        if ((await evaluate(cdp, passwordField)) !== true) {
          if (args.submitSelector) {
            await evaluate(cdp, "document.querySelector(" + selectorJson(args.submitSelector) + ")?.click()");
          } else {
            await pressEnter(cdp);
          }
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline && (await evaluate(cdp, passwordField)) !== true) {
            await new Promise((done) => setTimeout(done, 250));
          }
        }
        await fill(cdp, passSelector, secret.secret);
        if (args.submitSelector) {
          await evaluate(cdp, "document.querySelector(" + selectorJson(args.submitSelector) + ")?.click()");
        } else {
          await pressEnter(cdp);
        }
        await new Promise((done) => setTimeout(done, 1200));
        return {
          output: [
            {
              type: "text" as const,
              text:
                "Filled the form for " + secret.label + " from the vault (values never shown) and submitted.\n\n" +
                (await pageSummary(cdp)),
            },
          ],
        };
      }

      if (args.action === "click") {
        const selector = args.selector ?? "";
        const outcome = await evaluate(
          cdp,
          "(() => { const el = document.querySelector(" + selectorJson(selector) + "); if (!el) return 'missing'; " +
            "el.scrollIntoView({ block: 'center' }); el.click(); return 'ok'; })()",
        );
        if (outcome !== "ok") throw new Error("no element matched " + selector);
        await new Promise((done) => setTimeout(done, 500));
        return { output: [{ type: "text" as const, text: "Clicked " + selector + ".\n\n" + (await pageSummary(cdp)) }] };
      }

      if (args.action === "type") {
        const selector = args.selector ?? "";
        if (!selector) throw new Error("type needs a selector");
        await fill(cdp, selector, args.text ?? "");
        if (args.submit) {
          await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
          await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
          await new Promise((done) => setTimeout(done, 800));
        }
        return {
          output: [
            {
              type: "text" as const,
              text:
                "Typed into " + selector + (args.submit ? " and pressed Enter" : "") + ".\n\n" + (await pageSummary(cdp)),
            },
          ],
        };
      }

      if (args.action === "screenshot") {
        const shot = (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 62 })) as { data?: string };
        if (!shot.data) throw new Error("the page did not return a screenshot");
        mkdirSync(browserArtifactDir, { recursive: true, mode: 0o700 });
        const file = resolve(browserArtifactDir, "shot-" + Date.now() + ".jpg");
        writeFileSync(file, Buffer.from(shot.data, "base64"), { mode: 0o600 });
        const summary = await pageSummary(cdp, 400);
        return {
          output: [
            {
              type: "text" as const,
              text: "Screenshot saved to " + file + ".\n\n" + summary,
            },
          ],
        };
      }

      return { output: [{ type: "text" as const, text: await pageSummary(cdp) }] };
    } catch (error) {
      return {
        output: [{ type: "text" as const, text: "Browser action failed: " + String(error instanceof Error ? error.message : error) }],
        isError: true,
      };
    } finally {
      release();
    }
  },
});
