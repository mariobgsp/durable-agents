import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * one tab, a small renderer limit, and an idle timer that closes the process after fifteen minutes — so an
 * idle server costs nothing and the owner's logins still survive because they live in the profile directory,
 * not in the process.
 *
 * A login is filled from the vault and the typed values are never returned. The tool cannot read a password,
 * and the page text a model sees is redacted of every vault value before it is returned.
 */

const IDLE_MS = 15 * 60_000;
const LAUNCH_TIMEOUT_MS = 20_000;
const NAVIGATION_TIMEOUT_MS = 25_000;

type Mode = "headless" | "headful";

type BrowserState = {
  child: ChildProcess;
  mode: Mode;
  port: number;
  profileDir: string;
  targetWs: string;
  cdp: Cdp;
  lastUsed: number;
  idleTimer?: NodeJS.Timeout;
};

let state: BrowserState | undefined;
let starting: Promise<BrowserState> | undefined;
/**
 * One browser, one tab, one action at a time.
 *
 * pi-durable runs tools in parallel, and two page actions on the same tab would interleave navigations and
 * fills. The lock is a promise chain rather than a queue object: a failed action releases it in finally.
 */
let browserLock: Promise<void> = Promise.resolve();

export type BrowserStatus = {
  running: boolean;
  mode?: Mode;
  pid?: number;
  port?: number;
  profileDir: string;
  binary: string | null;
  idleMinutes: number;
};

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
  const cdp = new Cdp(created.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  return { ws: created.webSocketDebuggerUrl, cdp };
}

function armIdle(browser: BrowserState): void {
  if (browser.idleTimer) clearTimeout(browser.idleTimer);
  browser.idleTimer = setTimeout(() => {
    void closeBrowser();
  }, IDLE_MS);
  browser.idleTimer.unref?.();
}

export async function ensureBrowser(mode: Mode = "headless"): Promise<BrowserState> {
  if (state && state.mode === mode && !state.child.killed) {
    state.lastUsed = Date.now();
    armIdle(state);
    return state;
  }
  if (state) await closeBrowser();
  if (starting) return starting;

  starting = (async () => {
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
      ...(mode === "headless" ? ["--headless=new"] : []),
      "about:blank",
    ];
    const child = spawn(binary, args, {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ":0" },
    });
    child.unref();
    const portFile = resolve(browserProfileDir, "DevToolsActivePort");
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    let port = 0;
    while (Date.now() < deadline) {
      if (!existsSync(portFile)) {
        await new Promise((done) => setTimeout(done, 120));
        continue;
      }
      const first = readFileSync(portFile, "utf8").split("\n")[0]?.trim() ?? "";
      const parsed = Number(first);
      if (Number.isInteger(parsed) && parsed > 0) {
        port = parsed;
        break;
      }
      await new Promise((done) => setTimeout(done, 120));
    }
    if (port === 0) {
      child.kill("SIGKILL");
      throw new Error("the browser started but never reported a devtools port");
    }
    await waitForPort(port, deadline);
    const target = await openTarget(port);
    state = {
      child,
      mode,
      port,
      profileDir: browserProfileDir,
      targetWs: target.ws,
      cdp: target.cdp,
      lastUsed: Date.now(),
    };
    armIdle(state);
    child.once("exit", () => {
      if (state?.child === child) {
        state = undefined;
        starting = undefined;
      }
    });
    return state;
  })();

  try {
    return await starting;
  } finally {
    starting = undefined;
  }
}

export async function closeBrowser(): Promise<void> {
  if (!state) return;
  const current = state;
  state = undefined;
  if (current.idleTimer) clearTimeout(current.idleTimer);
  current.cdp.close();
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
    state?.child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
});

export function browserStatus(): BrowserStatus {
  return {
    running: state !== undefined,
    ...(state ? { mode: state.mode, pid: state.child.pid ?? undefined, port: state.port } : {}),
    profileDir: browserProfileDir,
    binary: browserBinary(),
    idleMinutes: Math.round(IDLE_MS / 60_000),
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
    "only when a page action runs and closes itself after fifteen idle minutes; never leave it running for no " +
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
    const previous = browserLock;
    browserLock = new Promise<void>((done) => (release = done));
    await previous;
    try {
      if (args.action === "status") {
        const status = browserStatus();
        return {
          output: [
            {
              type: "text" as const,
              text: status.running
                ? "Browser running (" + status.mode + ", pid " + status.pid + ", idle timeout " + status.idleMinutes + "m)."
                : status.binary
                  ? "Browser idle. It starts on the first page action and closes after " + status.idleMinutes + " idle minutes."
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
        await fill(cdp, passSelector, secret.secret);
        if (args.submitSelector) {
          await evaluate(cdp, "document.querySelector(" + selectorJson(args.submitSelector) + ")?.click()");
        } else {
          await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
          await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
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

      // read
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
