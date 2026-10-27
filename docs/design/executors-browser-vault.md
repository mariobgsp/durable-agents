# Terminal, coding executors, browser and vault

Four capabilities added together because they share one rule: an agent acts on the owner's machine or in the
owner's sessions, and the owner must never have to leave the thread to see what happened or to hand over a
credential.

## Terminal

**terminal** runs one command per call in /bin/bash, in the agent's own scratch directory unless a cwd is given.

- The child environment is the server's environment minus every key matching TOKEN, SECRET, PASSWORD, API_KEY,
  any *_KEY, and the PI_ prefix; HOME, PATH, TERM, LANG, SHELL and TMPDIR are kept, and CI, TERM=dumb, PAGER=cat
  and GIT_PAGER=cat are set. This is what stops a command from printing the server token.
- Output is captured with a 4 MB in-memory ceiling (head and tail kept, middle discarded) and returned at most
  24,000 characters, with a byte-counted truncation note.
- The result starts with the command and the directory, ends with the exit code, and marks a timeout or a
  non-zero exit as an error. The whole process group is killed on timeout.
- State does not persist between calls by design: no long-lived shell, so an idle server has no shell process.

The transcript keeps one trace line per call; the full output is the durable record the model reads. The agent's
working rules tell it to summarise that record — files, diff stat, the decisive test lines — in its answer,
because the owner reads the thread and never opens a terminal to find out what happened.

## Coding executors: pi, opencode or durable

The **coding** tool hands a self-contained prompt to an already-authenticated local CLI, or keeps the work here.

- **durable** spawns nothing and tells the model to continue with its own read/write/edit/bash/terminal tools.
- **pi** runs pi -p PROMPT --mode text (plus -c to continue), which reuses the login in ~/.pi/agent/auth.json.
- **opencode** runs opencode run PROMPT (plus --continue). It is probed first; when it is absent the tool returns
  a readable refusal naming PATH and how to install it, never an exception.
- Both CLIs get the same scrubbed environment as the terminal. Output is capped at 24,000 characters, a
  10-minute default timeout applies (30-minute cap), and an auth-looking failure appends the one command that
  fixes it.

The ask-once policy lives in the system prompt (agents.ts, workingSection). When the owner asks for code and the
thread has not chosen an executor, the agent must ask with the **question** tool and offer durable, pi and
opencode; it must not ask again after a choice, and it must say which option is unavailable. Choosing pi or
opencode is also recorded by the tool result, so the next turn knows what happened.

## Browser

One real Chromium, on demand, over CDP.

- **Lifecycle**: the process starts on the first page action, uses one process, one tab and
  renderer-process-limit=1, and is closed by a 15-minute idle timer and by server shutdown. Reading status never
  starts it.
- **Sessions**: one persistent profile at data/browser/profile holds the owner's logins, so an agent works with
  the session the owner already has. Headless is the default; headful is a per-call option and needs a display.
  The API exposes whether the browser runs and where the profile lives, never a cookie or a session token.
- **Actions**: open, read, click, type, login, screenshot, close, status. Screenshots are JPEG artifacts under
  data/browser/shots and the tool returns the path, not megabytes of base64.
- **Logins**: login resolves a vault label, navigates, fills the username and password fields and submits. The
  values are never returned, echoed or logged; the tool result is the resulting page summary.
- **Safety**: only http and https pages can be opened.

## Vault

Credentials are write-and-list only, encrypted at rest, and never rendered.

- AES-256-GCM with a 32-byte key; the key and the store are 0600 inside a 0700 data/vault directory. A damaged
  key is an error, not a regeneration, because regenerating would silently destroy every stored secret.
- Public shapes carry a fixed bullet mask and a hasUsername flag — never a length and never a prefix. There is no
  HTTP route that decrypts; the browser fill is the only reader.
- An agent asks with **vault action=request**. The server writes a chat.secret-request entry and ends the turn;
  the client renders a masked form that posts straight to **POST /api/vault** and then sends only the label back
  as a message. The password never enters the model's context or the transcript.
- Redaction is applied to every transcript entry on the way out (user, assistant, system and tool lines), so a
  value the owner pasted before the vault existed is masked from the next read on.
- data/vault and data/browser are named again in .gitignore even though data/ already covers them. The vault
  status reports git check-ignore rather than assuming it.
- Replacing a label overwrites in place; deleting removes entry and redaction together. Losing the key loses the
  secrets by design.

## Evidence

**terminal**, **secrets**, **coding**, **browser** and **browser-live** are deterministic E2E scenarios: the
terminal one proves the environment scrub and exit codes, secrets proves ciphertext on disk, 0600/0700 modes, no
plaintext in any API response and transcript redaction, coding proves the durable branch spawns nothing and the
absent-CLI refusal, browser proves status must not launch and the executors are probed without throwing, and
browser-live performs one real headless launch against a local page and then closes it.

Boot memory is measured, not assumed: with all four modules lazy, the server's resident size at rest is within
run-to-run noise of the pre-feature build, and ps shows no child process until an action runs.
