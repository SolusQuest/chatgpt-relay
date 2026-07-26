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
- **Durable SQLite queue**: tasks survive relay restarts, page refreshes, browser
  restarts, and agent interruptions.
- **Late-reply recovery**: client wait timeouts and task deadlines are separate.
  Replies that arrive during the bounded recovery window are stored in
  `lateReply` without rewriting the terminal task status.
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
└── test/                 Unit, integration, E2E, and extension tests
```

## Requirements

- Node.js 22 or later
- Chrome, Edge, Brave, or another Chromium browser with MV3 support

## Quick start

### 1. Install dependencies

```bash
git clone <repository-url>
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

## Common commands

```bash
gpt-relay start
gpt-relay health
gpt-relay sessions
gpt-relay tasks --last 20
gpt-relay show <task-id>
gpt-relay cancel <task-id>
gpt-relay resume
gpt-relay review --session <session-id> --stdin
```

## API summary

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/tasks` | Submit a task |
| `GET` | `/v1/tasks/:id?wait=30000` | Read or long-poll a task |
| `GET` | `/v1/tasks?session=&status=&limit=` | List tasks |
| `DELETE` | `/v1/tasks/:id` | Cancel a task |
| `GET` | `/v1/sessions` | List active sessions |
| `POST` | `/v1/sessions/:id/pause` | Pause a session |
| `POST` | `/v1/sessions/:id/resume` | Resume a session |
| `GET` | `/health` | Check relay health |

See [`api.md`](./api.md) for the complete public API, task lifecycle, and
extension-only `/internal/*` endpoints.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GPT_RELAY_PORT` | `8765` | Relay port |
| `GPT_RELAY_HOST` | `127.0.0.1` | Bind address |
| `GPT_RELAY_DATA_DIR` | `~/.gpt-relay` | Data directory |
| `GPT_RELAY_DB_FILE` | `~/.gpt-relay/gpt-relay.db` | SQLite database |
| `GPT_RELAY_DEFAULT_TIMEOUT_MS` | `1800000` | Default task timeout |
| `GPT_RELAY_MAX_TASK_TIMEOUT_MS` | `3600000` | Maximum task timeout |
| `GPT_RELAY_ACTIVE_TASK_GRACE_MS` | `60000` | Grace after the hard deadline |
| `GPT_RELAY_LATE_REPLY_GRACE_MS` | `1800000` | Late-reply recovery window |
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
| A review wait times out | Keep the task ID and use `gpt-relay resume` or `show` |

## Documentation

- [`agent-instructions.md`](./agent-instructions.md): operational rules for
  agent review and discussion
- [`api.md`](./api.md): HTTP API, lifecycle, timeout, and recovery semantics
- [`workflows/`](./workflows/README.md): multi-stage orchestration templates
- [`extension/README.md`](./extension/README.md): extension setup and recovery

## License

The project license will be declared in a root `LICENSE` file before the first
public release.
