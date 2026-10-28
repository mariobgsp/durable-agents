# Setup wizard

Five steps, fixed order, resumable:

1. **Agents** — the orchestrator is always asked for when missing and offered for replacement when present; extra
   agents can be staged. Model and bot are deferred, so nothing is written yet.
2. **Provider** — detect pi authentication, credentials.json and env; default opencode-go; or add a built-in
   provider by API key (validated with getAvailable). The chosen model becomes the default for staged agents.
3. **Telegram** — add bots (getMe), bind the owner (/start code or --owner-id), assign a home bot per agent, then
   write staged agents atomically through the admin pipeline.
4. **Service** — optional systemd unit, optional host tuning report.
5. **Connection test** — start the daemon, run the same checks as `dura verify` (provider completion, bot identity,
   owner delivery, socket/no-TCP, SQLite, one live agent answer). Only a pass writes `setup.verifiedAt`.

Completion is recorded in `config.setup.completed`; a re-run resumes at the first unfinished step. `--skip-test`
records the test as skipped and never writes verifiedAt.
