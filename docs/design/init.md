# Setup wizard

Five steps, fixed order, resumable:

1. **Agents** — the orchestrator is always asked for when missing and offered for replacement when present; extra
   agents can be staged. Model and bot are deferred, so nothing is written yet.
2. **Provider** — detect pi authentication, credentials.json and env; default opencode-go; or add a built-in
   provider by API key (validated with getAvailable). The chosen model becomes the default for staged agents.
3. **Chat surface** — the user chooses **Telegram bot** or **Discord bot**.
   - Telegram: add bots (getMe), bind the owner (/start code or --owner-id), assign a home bot per agent.
   - Discord: validate the token (getMe + application), print the invite URL and required permissions, bind the
     owner id, set a default agent, and register slash commands on first start.
   - Either way, staged agents are written atomically through the admin pipeline and `chat:<platform>` is recorded.
4. **Service** — optional systemd unit, optional host tuning report.
5. **Connection test** — start the daemon, run the same checks as `dura verify` (provider completion, surface
   identity/gateway, owner delivery, socket/no-TCP, SQLite, one live agent answer). Only a pass writes
   `setup.verifiedAt`.

Completion is recorded in `config.setup.completed`; a re-run resumes at the first unfinished step. Legacy
`telegram` entries count as `chat:telegram`. `--skip-test` records the test as skipped and never writes
`verifiedAt`. Only one surface is configured per run; switching later is `dura chat use <platform>`.
