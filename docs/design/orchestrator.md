# Orchestrator and agent administration

The orchestrator is `config.orchestrator.agentId`, cached at boot for synchronous tool selection. Admin tools are
added to a conversation only when its agent is the orchestrator, and each tool re-checks the guard.

## Tools

- `agent_admin_list`, `agent_read`, `agent_create`, `agent_update`, `agent_set_enabled`, `agent_delete`,
  `agent_suggest`.
- `orchestrator_claim` is registered for every conversation and offered to every agent; the owner approves a claim
  when another orchestrator already exists.
- `agent_write_doc`: sha256 guard, replace/append/patch, 64 KiB cap, five history entries, immediate rebind.
- Mesh: `agents_list`, `agents_message`, `agents_delegate`.
- Bots: `bot_list`, `bot_assign`, `bot_release` (one bot is one agent).
- MCP: `mcp_list`, `mcp_add`, `mcp_remove` (global tools; every agent receives them).

## Rules

- Several `agent_create` calls in one round are allowed and run in parallel.
- With several bots, an omitted `telegramBot` returns an instruction to ask the owner; with one bot it is used and
  reported.
- The orchestrator cannot edit MEMORY.md, read vault values, move its own pointer, delete itself, or disable itself
  through a tool.
- Any agent may call `orchestrator_claim`. With no orchestrator it takes the role immediately; otherwise the owner
  gets Approve/Deny buttons. A pointer change rebinds both the old and the new agent so the admin tools follow the
  role in existing threads.
- Every mutation goes through `core/agent-admin.ts`: validate, write, rebind, reconcile mesh/schedules, validate
  references, emit an event, notify the owner, log one info line. Direct filesystem edits are detected by a watcher
  and rebound with a warning.
