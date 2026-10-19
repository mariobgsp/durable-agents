# Reaching dura-agents from a phone (Tailscale)

The server speaks plain HTTP on loopback and authenticates with a token. That is the right shape for a
single-user app, but it means a phone cannot reach it without two things in front of it: **TLS**, because iOS
and Android refuse service workers and treat a PWA as untrusted over plain HTTP, and a **route**, because
`127.0.0.1` is not reachable from another device.

[Tailscale](https://tailscale.com) provides both without opening a port, buying a domain, or exposing anything
to the public internet: the server gets a private `*.ts.net` name with a real certificate, and only devices in
your tailnet can resolve it. The phone then installs the web UI as an app.

Everything below is written for a small always-somewhere machine (the reference target is a laptop with 4 GB of
RAM) and for an iPhone or an Android phone. Commands marked `server` run on the machine that will host the app.

---

## What you need

- Node.js **>= 22.19** on the server (the repository's `engines` field). `node:sqlite` is built in, so there is
  no database to install.
- A Tailscale account, and the Tailscale app on the server and on the phone.
- About 140 MB of RSS for the app in production mode (measured on an idle server; it grows with the
  conversations it holds). The build is the memory-hungry part, not the run.

---

## 1. Put the code on the server

Two ways. Choose the fast one if the server is small or slow.

### a. Build on the server

```bash
git clone <your-remote> dura-agents
cd dura-agents
npm ci
npm run build          # writes packages/web/dist
```

`npm run build` runs Vite and can need more than 2 GB. On a 4 GB machine, add swap first:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
```

### b. Build elsewhere and copy the result

The runtime has **no native modules** (SQLite is `node:sqlite`; the only `.node` files in the tree belong to
Vite and are never loaded at runtime), so a build from another x86_64 machine can be copied over:

```bash
# on the machine that builds
npm ci && npm run build

# to the server
rsync -a --exclude data --exclude .git ./ server:~/dura-agents/
```

Either way, `packages/web/dist/index.html` must exist before `npm start`, or the server serves the API only.

---

## 2. First run, and the token

```bash
npm start            # production: one process serving UI + API + WebSocket on 8787
```

On the first start the server creates `data/token` (32 random bytes, mode `600`) and reuses it from then on. It
is injected into the HTML the server sends, so the browser never asks for it. Every `/api` request needs it in
an `X-PI-Token` header, or as `?token=` on the WebSocket handshake.

Credentials for the model providers belong to the machine that runs the server. Put the key in through the
app's **Models** screen (stored in `data/credentials.json`) rather than copying your whole `~/.pi` directory:
whatever the server holds, an agent with the `bash` tool can reach.

Stop it with `Ctrl-C` for now. It comes back as a service in step 4.

---

## 3. Tailscale on the server

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale status                 # note your machine name, e.g. fedora.tail1a2b3c.ts.net
```

Before `tailscale serve` will issue a certificate, **HTTPS must be enabled for your tailnet**: open the
[Tailscale admin console](https://login.tailscale.com/admin/dns) → DNS → *HTTPS Certificates* → enable. The
command below prints a link to that page if you forget.

Serve the app over HTTPS on the tailnet:

```bash
sudo tailscale serve --bg 8787
sudo tailscale serve status      # https://fedora.tail1a2b3c.ts.net -> http://127.0.0.1:8787
```

`--bg` keeps it running after you log out. Tailscale terminates TLS and proxies to loopback, so the app itself
still never listens on a public interface.

> Do not use `tailscale funnel` here. Funnel publishes to the internet; `serve` stays inside your tailnet.

---

## 4. Allow the hostname, or every request is 403

The server rejects a request whose `Host` header is not allowlisted (an anti-DNS-rebinding check). The
loopback names are allowed by default; anything else must be listed in `PI_ALLOWED_HOSTS`:

```bash
PI_ALLOWED_HOSTS=fedora.tail1a2b3c.ts.net npm start
# or, for any tailnet machine:
PI_ALLOWED_HOSTS=.ts.net npm start
```

A leading dot matches every subdomain, so `.ts.net` is the portable choice; the exact name is the tighter one.
This check is **not** the authentication: the token is still required. It only decides which names may talk to
the API at all.

Quick proof, without the phone:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: fedora.tail1a2b3c.ts.net" http://127.0.0.1:8787/api/health
# 401  -> the host was accepted, the token is missing (correct)
# 403  -> the host is not in PI_ALLOWED_HOSTS
```

---

## 5. Run it as a user service

The unit in [`deploy/dura-agents.service`](../deploy/dura-agents.service) is ready apart from the hostname:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/dura-agents.service ~/.config/systemd/user/
$EDITOR ~/.config/systemd/user/dura-agents.service   # set PI_ALLOWED_HOSTS
systemctl --user daemon-reload
systemctl --user enable --now dura-agents
loginctl enable-linger "$USER"                       # start on boot, survive logout
```

`enable-linger` is the part people forget: without it the service only exists while you are logged in, so after
a reboot the phone finds nothing.

Check it:

```bash
systemctl --user status dura-agents
journalctl --user -u dura-agents -f
```

---

## 6. Install it on the phone

First install Tailscale on the phone and sign in to the **same tailnet** — the app is invisible without it.

### iPhone

1. Open Safari (Chrome on iOS cannot install a PWA) and go to `https://fedora.tail1a2b3c.ts.net`.
2. Wait for the page to load once, so the service worker registers.
3. Share → **Add to Home Screen**.
4. The icon opens standalone: no address bar, dark status bar. It is called **Dura**.

### Android

1. Open Chrome and go to the same URL.
2. Menu → **Install app** (or *Add to Home screen*).
3. The icon opens standalone with the app's theme colour.

The home-screen icon, the splash background and the manifest are all served by the app, so a reinstall after an
update is never necessary — reloading is enough.

---

## 7. Verify end to end

From the phone, with Tailscale connected:

- The page loads, and the sidebar footer says **connected** (that is the WebSocket).
- Sending a message streams an answer.
- Under the composer, the context caption and the model picker are populated.

From a desktop in the tailnet, the same URL works in a browser. From a machine *outside* the tailnet, the name
does not resolve at all — that is the intended failure.

---

## 8. Everyday operation

| Task | Command |
| --- | --- |
| Logs | `journalctl --user -u dura-agents -f` |
| Restart (in-app) | `#/system` → **Restart**. The unit's `Restart=always` brings it back in about 3 s. |
| Restart (host) | `systemctl --user restart dura-agents` |
| Update (in-app) | `#/system` → **Update** on a writable checkout. Under the unit the repo is read-only, so the button reads **Reload tools** and says why; package updates stay on the host. |
| Update (host) | `git pull && npm ci && npm run build && systemctl --user restart dura-agents` |
| Checks after an update | `npm run check` and `npm run e2e` |
| Where the state lives | `data/app.sqlite`, `data/sessions.json`, `data/agents/`, `data/credentials.json`, `data/token` |

Back up `data/` and nothing else: it is the whole application state — threads, transcripts, agents, their
`AGENT.md` / `SOUL.md` / `MEMORY.md`, provider credentials and the token. Agent scratch space lives outside the
repository in `~/tmp/<agent-id>` and is disposable by design.

Two things move that state out of `data/`:

- `PI_DATA_DIR` points the server at another directory. Set it in the unit if you want the data on a different
  disk.
- `PI_AGENT_TMP_DIR` moves the per-agent scratch root away from `~/tmp`.

---

## 9. Limits worth knowing before you rely on it

- **No push notifications.** A WebSocket pushes only while the page is open, and iOS suspends a backgrounded
  PWA. The phone will not tell you when an agent finishes; you find out when you open it.
- **The server must be awake.** Tailscale reconnects on its own after a suspend, but a sleeping machine serves
  nothing. If the laptop is closed, the phone sees a spinner, not an error.
- **One user, by design.** The token is a bearer secret: anyone who obtains it (and is on the tailnet) has the
  app. There is no per-user account, no rate limit, and agents with the `bash` tool run real commands on the
  server.
- **Memory reaches the model in new threads.** An agent's `MEMORY.md` is compiled into its instructions when a
  conversation is created or reconfigured; a thread that was already open keeps the instructions it started
  with.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `403 Host not allowed` | `PI_ALLOWED_HOSTS` does not contain the name in the URL |
| `401 Token missing` | The page was loaded from a stale tab; reload it so `window.__PI_BOOT__` is fresh |
| Page loads, footer says *idle* or *reconnecting…* | The WebSocket is blocked: check `tailscale serve status`, and that the URL is `https`, not `http` |
| `tailscale serve` complains about certificates | HTTPS certificates are not enabled for the tailnet (admin console → DNS) |
| Phone shows "cannot connect" | Tailscale is off on the phone, or the phone is on a different tailnet |
| Add to Home Screen produces a generic icon | The page was added before the icons were served; remove and add again |
| Works on the phone, not on a desktop outside the tailnet | Expected: the name only resolves inside the tailnet |
