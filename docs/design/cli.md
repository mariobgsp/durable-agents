# CLI and daemon

The CLI is a client. Only `dura start` runs the daemon; every other command either reads files (agents, config,
vault) or speaks NDJSON over `$DURA_HOME/run/daemon.sock`.

## Process model

- One daemon: harness, SQLite, scheduler, mesh, run limiter, IPC server, one poller per bot.
- Lockfile `run/daemon.lock` (pid, liveness check) enforces a single instance; exit code 4 on a second start.
- Readiness is a 0600 `run/ready.json` plus one `DURA_READY` stdout line, so a detached start needs no pipe.
- SIGINT/SIGTERM stop pollers (aborting the in-flight long poll), the scheduler, IPC and the harness within 15 s.

## Boot

`systemctl --user` starts the unit at boot only when it is enabled and the user lingers; `dura service install`
reads both back instead of assuming them. The unit cannot order against the network — the user manager has no
`network-online.target` — so a transport whose first identity call fails retries it with backoff, and a bot that
comes up late reports its restart and recovers pending deliveries then. `boot()` opens the harness and calls
`resume()` before any transport or the scheduler can read the store, so interrupted runs are rescheduled first.

## IPC

```text
-> {"id":"1","method":"sessions.list","params":{}}
<- {"id":"1","ok":true,"result":[...]}
<- {"event":"fleet","data":{...}}
```

Methods cover status/doctor/verify, fleet subscribe, bots, providers, agents/docs, orchestrator, sessions, usage,
memory, storage, schedules, users, config, system. Errors carry `{code,message}`.

## Exit codes

0 ok · 1 runtime · 2 usage · 3 daemon unavailable · 4 refused (guard, unknown bot, destructive without --yes).
