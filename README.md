# gpt-relay

gpt-relay is a local relay service and browser extension that lets coding agents
request reviews, second opinions, and long-form analysis through the user's own
ChatGPT web session.

It does not use the OpenAI API and therefore does not create OpenAI API usage
charges. It does use the user's ChatGPT account and remains subject to that
account's plan limits and the applicable OpenAI terms.

## Features

- **Browser-controlled execution**: a Chrome-compatible extension submits tasks
  through the normal ChatGPT web interface.
- **Concurrent sessions**: multiple ChatGPT tabs can process independent review
  tasks in parallel.
- **Agent-created conversations**: create a chat with its first message, explicitly select a Project or no Project, and reuse a stable `sessionRef` while retaining legacy session IDs.
- **Local Project catalog**: query and maintain names and descriptions for Project IDs without changing Projects on ChatGPT.
- **Durable SQLite queue**: tasks survive relay restarts, page refreshes, browser
  restarts, and agent interruptions.
- **At-most-once browser delivery**: the extension persists a send fence before selecting Send. Refresh and restart recovery observe uncertain work instead of automatically replaying a prompt.
- **Bounded submission verification**: an unacknowledged Send fence is resolved
  after a fixed two-minute observation window as acknowledged, not observed, or
  genuinely unknown, with late replies able to correct an early operational
  failure.
- **Liveness-first composer cleanup**: stale composer content is cleared on a
  bounded best-effort basis and new text replaces old text without blocking a
  usable Send path.
- **Soft-deadline recovery**: a page-submitted task becomes non-terminal
  `recovering` after its normal lifetime. Strong page evidence renews a bounded
  lease, so a long ChatGPT reply can still finish without inviting a duplicate
  submission.
- **Late-reply compatibility**: replies discovered after an early terminal
  failure can still be stored in `lateReply` during the bounded recovery window.
- **Background processing**: an MV3 service worker drives polling and recovery
  without requiring the ChatGPT tab to stay focused.
- **Network recovery**: the extension observes network failures and page
  connectivity changes and can reload when necessary.
- **Agent-friendly interfaces**: a CLI, TypeScript client, and versioned REST API
  support long polling, idempotency, status inspection, and recovery.

## Repository layout

```text
gpt-relay/
├── server/               Express and node:sqlite relay service
├── bin/gpt-relay.ts      CLI entry point
├── client/               TypeScript agent client
├── extension/            Chrome-compatible MV3 extension
├── scripts/              Maintenance scripts
├── workflows/            Composable agent workflows
├── agent-instructions.md Relay review and discussion guide for agents
├── api.md                HTTP API and task lifecycle reference
├── task-lifecycle.md     State machine and recovery rules
└── test/                 Unit, integration, E2E, and extension tests
```

## Requirements

- Node.js 22 or later
- Chrome, Edge, Brave, or another Chromium browser with MV3 support

## Quick start

### 1. Install dependencies

```bash
git clone https://github.com/SolusQuest/chatgpt-relay.git
cd gpt-relay
npm install
```

### 2. Start the relay

```bash
npm start
```

After a global installation, you can instead run:

```bash
npm install -g .
gpt-relay start
```

The relay listens on `127.0.0.1:8765` by default. Its data is stored under
`~/.gpt-relay/`.

### 3. Load the extension

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose the repository's `extension/` directory.
4. Open or refresh `https://chatgpt.com/`.
5. Confirm that a green `Relay: <session-id>` banner appears.

### 4. Submit a review

With the CLI:

```bash
printf '%s' 'Review this code...' |
  gpt-relay review --session <session-id> --stdin
```

With the REST API:

```bash
curl -X POST http://127.0.0.1:8765/v1/tasks \
  -H "Content-Type: application/json" \
  -d '{"session":"<session-id>","text":"Review this code..."}'
```

Find the session ID with `gpt-relay sessions` or in the extension popup.

To create a new conversation, generate and retain a reference and submit its first message:

```bash
gpt-relay projects --json
gpt-relay review --new-session --session-ref <ref> --no-project --file <prompt-file> --no-wait
gpt-relay sessions --session-ref <ref> --json
gpt-relay review --session-ref <ref> --file <follow-up-file> --no-wait
```

Use `--project-id <id>` instead of `--no-project` for a Project chat. Maintain the local catalog with `gpt-relay projects set --project-id <id> --name "Name" --description "Purpose"` and `gpt-relay projects remove --project-id <id>`. Use `gpt-relay projects discover` to preview visible Project links in open ChatGPT tabs, or add `--save` to merge them into the catalog. Discovery preserves descriptions and unseen entries and reports partial coverage. It does not expand the sidebar or navigate tabs. See the agent guide for first-message context, creation failure boundaries and request recovery.

## Common commands

```bash
gpt-relay start
gpt-relay health
gpt-relay sessions
gpt-relay sessions inspect --session-ref <ref>
gpt-relay doctor --session-ref <ref>
gpt-relay tasks trace <task-id>
gpt-relay sessions suspend --session-ref <ref>
gpt-relay sessions continue --session-ref <ref>
gpt-relay tasks recover <task-id>
gpt-relay sessions refresh --session-ref <ref>
gpt-relay tasks stop <task-id>
gpt-relay operations <operation-id>
gpt-relay tasks --last 20
gpt-relay show <task-id>
gpt-relay cancel <task-id>
gpt-relay resume
gpt-relay review --session <session-id> --stdin
```

## API summary

Maintenance commands return JSON. `suspend` stops new claims while existing work continues; queued tasks retain their original expiry. `continue` releases only that dispatch suspension. Safety `pause`/`resume` remain separate.

`inspect` uses page observations with a 30-second freshness limit and explicitly reports missing or ambiguous pages. `doctor` exits 2 when attention is required; null selector capabilities mean unobserved. `trace` persists lifecycle events without prompt/reply content; tasks predating trace installation report `completeHistory: false`.

`recover`, `refresh`, and `stop` enqueue independent control operations. Retain the returned `operationId` and query `operations` until terminal. A queued operation is not success. Use `--operation-id <same-id>` when retrying an uncertain HTTP request; the CLI prints the identifier to stderr before submitting. Commands expire after two minutes. `unknown` requires inspection, not a new operation ID and blind retry.

Refresh defaults to an idle page with an empty composer. To reload while observing a previously sent task, use `sessions refresh --session-ref <ref> --recover-task <task-id>`. It requires the original task's durable correlation evidence and never sends it again. Refresh refuses drafts, unknown page state and multiple candidate tabs. It waits for a new document and readiness after reload; a broken content script must be repaired manually because draft safety cannot be verified. `tasks recover` resumes observation of an active sent task without refreshing. Automatic late-reply recovery after eligible terminal failures is unchanged.

`tasks stop` clicks Stop only for the original task's last user turn and reports `stopRequested`, `pageGenerationState`, and `relayTaskStatus` separately. `cancel` only cancels Relay tracking. HTTP and task failures include `errorInfo` with a stable code, delivery state, suggested next action, and conservative `safeToResubmit` (`false` or unknown/null).

Restart the relay server, reload the Edge extension and refresh ChatGPT pages after updating these components. Use `doctor` to verify the page protocol before issuing control commands.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/tasks` | Submit a task |
| `GET` | `/v1/tasks/:id?wait=30000` | Read or long-poll a task |
| `GET` | `/v1/tasks?session=&status=&limit=` | List tasks |
| `DELETE` | `/v1/tasks/:id` | Cancel a task |
| `GET` | `/v1/sessions` | List active sessions |
| `GET` | `/v1/sessions/:id/inspect` | Read server and fresh page state |
| `GET` | `/v1/doctor?session=:id` | Diagnose extension/page compatibility |
| `GET` | `/v1/tasks/:id/trace` | Read persistent lifecycle timeline |
| `POST` | `/v1/sessions/:id/suspend` or `/continue` | Hold/release new task claims |
| `POST` | `/v1/session-controls` | Request recover, refresh or stop |
| `GET` | `/v1/operations/:id` | Read control operation status |
| `POST` | `/v1/sessions/:id/pause` | Pause a session |
| `POST` | `/v1/sessions/:id/resume` | Resume a session |
| `GET` | `/health` | Check relay health |

See [`api.md`](./api.md) for the complete public API and extension-only
`/internal/*` endpoints. See [`task-lifecycle.md`](./task-lifecycle.md) for the
state machine and recovery decisions.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GPT_RELAY_PORT` | `8765` | Relay port |
| `GPT_RELAY_HOST` | `127.0.0.1` | Bind address |
| `GPT_RELAY_DATA_DIR` | `~/.gpt-relay` | Data directory |
| `GPT_RELAY_DB_FILE` | `~/.gpt-relay/gpt-relay.db` | SQLite database |
| `GPT_RELAY_DEFAULT_TIMEOUT_MS` | `1800000` | Default task lifetime before active-task grace |
| `GPT_RELAY_MAX_TASK_TIMEOUT_MS` | `3600000` | Maximum task timeout |
| `GPT_RELAY_ACTIVE_TASK_GRACE_MS` | `60000` | Grace before an active task enters recovery |
| `GPT_RELAY_RECOVERY_LEASE_MS` | `180000` | Recovery lease renewed by strong page evidence |
| `GPT_RELAY_LATE_REPLY_GRACE_MS` | `1800000` | Absolute recovery and late-reply window |
| `GPT_RELAY_MAX_TASK_BYTES` | `524288` | Maximum prompt size |
| `GPT_RELAY_MAX_QUEUED_PER_SESSION` | `50` | Per-session queue limit |

## Validation

```bash
npm run typecheck
npm test
npm pack --dry-run
```

## Data and privacy

Prompts and replies are stored locally in
`~/.gpt-relay/gpt-relay.db`. Pending CLI records are stored under
`~/.gpt-relay/pending/`.

Task content is submitted to the user's ChatGPT web session. Do not submit
credentials, secrets, or other content that the user has not authorized for
sharing with ChatGPT.

The server binds to loopback by default. Exposing it on another interface
changes the trust boundary and should be done only with appropriate network
controls.

To reset local relay data, stop the relay and remove the database files from
`~/.gpt-relay/`.

## Troubleshooting

| Symptom | Suggested action |
|---|---|
| `gpt-relay health` fails | Confirm that `npm start` or `gpt-relay start` is running |
| Relay banner is missing | Reload the extension, then refresh `chatgpt.com` |
| Popup reports `unreachable` | Check the relay URL and local firewall |
| Session is paused | Resolve the reported captcha or rate limit, then resume |
| Prompt submission fails | ChatGPT UI changes may require selector updates |
| Large pasted attachment times out | The failed task is not retried; the extension makes bounded cleanup attempts before the next dispatch without blocking a usable Send path |
| A review wait times out | Keep the task ID and use `gpt-relay resume` or `show` |
| A task is `recovering` | The original reply may still finish; do not resubmit it |

## Documentation

- [`agent-instructions.md`](./agent-instructions.md): operational rules for
  agent review and discussion
- [`api.md`](./api.md): HTTP API, lifecycle, timeout, and recovery semantics
- [`task-lifecycle.md`](./task-lifecycle.md): complete task state machine and
  soft-deadline recovery rules
- [`workflows/`](./workflows/README.md): multi-stage orchestration templates
- [`extension/README.md`](./extension/README.md): extension setup and recovery
- [`CONTRIBUTING.md`](./CONTRIBUTING.md): development and contribution guide
- [`SECURITY.md`](./SECURITY.md): vulnerability reporting and trust boundaries

## License

Licensed under the [MIT License](./LICENSE).
