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
- **Remote CLI backends**: bind clients to a server on a trusted LAN, discover servers through mDNS, and retain pending work by stable server identity.

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

- Node.js 22.18 or later
- pnpm 11.7.0 (declared in `package.json`)
- Chrome, Edge, Brave, or another Chromium browser with MV3 support

## Quick start

### 1. Install dependencies

```bash
git clone https://github.com/SolusQuest/chatgpt-relay.git
cd chatgpt-relay
pnpm install --frozen-lockfile
```

The development versions are pinned in `mise.toml`. With mise, run `mise trust` and `mise install` in the checkout before installing dependencies.

### 2. Start the relay

```bash
pnpm start
```

After a global installation, you can instead run:

```bash
pnpm add -g .
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

After a created session is bound, its `sessionRef` and ChatGPT conversation ID address the same Relay queue. Reopen the ordinary ChatGPT conversation URL after closing its tab; the extension restores the canonical identity from the server during registration. No creation marker or manual rebinding is needed. A different conversation opened in the same tab registers independently.

## Separate CLI and server computers

Run the server, browser and extension on computer A, and the CLI on computer B. Both computers install the same package; only A runs the server. `gpt-relay start` runs in the foreground; macOS also supports a login service.

On A, allow connections from the LAN. For example, on macOS:

```bash
GPT_RELAY_HOST=0.0.0.0 gpt-relay start
```

The browser extension on A can keep its default `http://127.0.0.1:8765` relay URL. On B:

```bash
gpt-relay bind <server-ip>:8765
gpt-relay health
gpt-relay sessions
```

Use `GPT_RELAY_PORT` on A to choose a different port. Discovery advertises the actual listener port; clients do not scan ports. LAN discovery uses DNS-SD `_gpt-relay._tcp` over mDNS (UDP 5353), and requires multicast connectivity between computers. If discovery is unavailable, use an explicit address with `bind` or `--server`.

Discovery publishes a separate `gpt-relay-<serverId>.local` host name so it does not conflict with the operating system's Bonjour host name, including on computers with multiple network interfaces. Set `GPT_RELAY_DISCOVERY=0` to disable LAN discovery without disabling direct connections.

```bash
gpt-relay bind                         # show saved binding and environment override
gpt-relay bind --local                 # save the unique local server
gpt-relay bind --clear                 # clear binding; retain pending records
gpt-relay detect                       # find and bind a server
gpt-relay detect --list --json          # list verified servers without binding
gpt-relay health --server <host>:8765   # temporary backend selection
gpt-relay health --local               # temporary local selection
```

`--local` uses the current user's server registry, including custom ports. It ignores environment and saved backend choices. It requires exactly one reachable local server and does not scan arbitrary ports. Servers remove registrations on graceful shutdown; unreachable or identity-mismatched registrations are ignored.

Client commands select a backend in this order: `--server` or `--local`, then `GPT_RELAY_URL`, then the saved binding, then discovery. The two flags are mutually exclusive and do not change the saved binding. Bare `host` uses port 8765; a full HTTP(S) URL follows its explicit scheme and port. Backend URLs must be origins without paths, query strings or credentials.

With no explicit backend, environment override or binding, a unique discovered server is automatically bound. Zero or multiple results produce an error and instructions to bind a backend. Only explicit `detect` in an interactive terminal offers a numbered choice; `detect --json` and ordinary commands never prompt. An unreachable or replaced bound server produces an error instead of silently selecting another server. Clearing a binding allows the next ordinary command to discover and bind again. `start` does not consult or change the client binding.

The server stores a stable identity in its SQLite database, while the CLI stores binding configuration separately in `~/.gpt-relay/client.json`. Pending records remain in the CLI computer's pending directory and include the originating server identity. `resume` checks only the selected backend, retains other-backend and missing-task records, and never resubmits them. Use `resume --server <original-server>` to observe work on another backend. Identity follows the database when its address changes. Legacy records with a matching origin are migrated only after matching task evidence; records without an origin remain retained.

Already running older servers remain usable through `GPT_RELAY_URL`, `--server`, or the legacy loopback fallback. Persisted binding and discovery require the new server identity API, activated when the server is next restarted. This change does not require an extension reload.

The default listener stays on loopback. A LAN listener trusts computers that can reach it; server identity prevents accidental backend switching and is not authentication. See [trust boundaries](./SECURITY.md#trust-boundaries).

### Start automatically at login (macOS)

Stop any foreground server first, then install a per-user LaunchAgent from the installed package or checkout:

```bash
GPT_RELAY_HOST=0.0.0.0 gpt-relay service install --dry-run
GPT_RELAY_HOST=0.0.0.0 gpt-relay service install
gpt-relay service status
gpt-relay health --local
```

The service starts immediately and at subsequent logins, restarts after exit, and uses the same database by default. It records absolute Node and package paths, so no shell, pnpm, or version-manager initialization is needed at login. Keep those paths installed. The browser still needs to be open with the extension enabled and ChatGPT signed in.

Use `gpt-relay service restart` after source updates. `service stop` stops it for the current login; `service start` starts it again. `service uninstall` stops it and removes login startup without deleting data or logs. See [service management](./docs/services.md) for configuration, logs, runtime upgrades, and platform support.

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
gpt-relay sessions open --session-ref <ref>
gpt-relay sessions close --session <conversation-id>
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

All session maintenance commands accept either `--session-ref <ref>` or `--session <id>`, exactly one per command. `open` reuses or opens an already bound conversation in a background tab; it requires the extension to be online, even when no ChatGPT tab is open. Use `doctor` to inspect instance identifiers and add `--instance <id>` to Open when selection is ambiguous. `close` requires a unique idle responsive page with a clean composer and suspends dispatch before removal. It preserves the session and queued work. After reopening, inspect the page and explicitly use `sessions continue` to resume suspended work. Open does not send a message, and Close does not request Stop. Both return operation IDs and use the same durable execution and result inspection rules as Refresh.

Doctor and inspection distinguish fresh instance inventory, missing tabs and unreachable page scripts. Instance heartbeats do not require a ChatGPT page, and expire after 90 seconds; stale heartbeat evidence cannot distinguish a closed browser from a disabled extension. Page evidence expires after 30 seconds. New page controls require the updated server and extension; updating source files alone does not activate the capability in an already running service.

`inspect` uses page observations with a 30-second freshness limit and explicitly reports missing or ambiguous pages. `doctor` exits 2 when attention is required; null selector capabilities mean unobserved. `trace` persists lifecycle events without prompt/reply content; tasks predating trace installation report `completeHistory: false`.

`recover`, `refresh`, and `stop` enqueue independent control operations. Retain the returned `operationId` and query `operations` until terminal. A queued operation is not success. Use `--operation-id <same-id>` when retrying an uncertain HTTP request; the CLI prints the identifier to stderr before submitting. Commands expire after two minutes. `unknown` requires inspection, not a new operation ID and blind retry.

Refresh defaults to an idle page with an empty composer. To reload while observing a previously sent task, use `sessions refresh --session-ref <ref> --recover-task <task-id>`. It requires the original task's durable correlation evidence and never sends it again. Refresh refuses drafts, unknown page state and multiple candidate tabs. It waits for a new document and readiness after reload; a broken content script must be repaired manually because draft safety cannot be verified. `tasks recover` resumes observation of an active sent task without refreshing. Automatic late-reply recovery after eligible terminal failures is unchanged.

`tasks stop` clicks Stop only for the original task's last user turn and reports `stopRequested`, `pageGenerationState`, and `relayTaskStatus` separately. `cancel` only cancels Relay tracking. HTTP and task failures include `errorInfo` with a stable code, delivery state, suggested next action, and conservative `safeToResubmit` (`false` or unknown/null).

After a worker restart, Stop observes the original task without clicking again, even if reply tracking was already cleaned up. A known task result is retained; `stopRequested` stays `null` without Stop evidence, and `pageGenerationState` stays `unknown` if the original user turn cannot be verified or the page is still loading.

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
| `GET` | `/v1/browser-instances` | Read extension instance heartbeat and complete tab inventories |
| `GET` | `/v1/tasks/:id/trace` | Read persistent lifecycle timeline |
| `POST` | `/v1/sessions/:id/suspend` or `/continue` | Hold/release new task claims |
| `POST` | `/v1/session-controls` | Request open, close, recover, refresh or stop |
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
pnpm run typecheck
pnpm test
pnpm pack --out package-check.tgz
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
| `gpt-relay health` fails | Confirm that `pnpm start` or `gpt-relay start` is running |
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

### Select thinking effort

Keep the model family selected in ChatGPT and set only its thinking preset:

```bash
gpt-relay sessions effort --session-ref sr_example --effort high
# Inspect the operation ID printed by the command before submitting work.
gpt-relay operations OPERATION_ID

gpt-relay review --new-session --session-ref sr_new --no-project \
  --effort max --text 'Review this proposal' --json
```

Supported values are `none | medium | high | max | pro`. The default is to fail
when a requested preset is unavailable. Opt into ordinary downward fallback with
`--effort-fallback lower`; Pro never automatically downgrades. The session policy
survives reload and is applied before subsequent Relay messages. Without a new
policy, existing behavior is preserved. Use session controls to change an
existing conversation; `review --effort` is accepted only with `--new-session`.

Effort-enabled results include the requested/effective preset and verification
of the platform-reported response model. A mismatch or unverifiable response
fails the task while retaining its reply. Inspect it using `show TASK_ID`; do not
automatically resend. See [effort API semantics](api.md#effort-selection).

After updating, restart the Relay service, reload the extension, and refresh
ChatGPT tabs so the new content-script module is loaded.
