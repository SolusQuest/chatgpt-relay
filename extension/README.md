# gpt-relay browser extension

This Chrome-compatible Manifest V3 extension executes relay tasks in the
ChatGPT web interface.

Project discovery uses visible DOM entries in open ChatGPT tabs, including classic Project links and current sidebar rows with Project ID and label attributes. Run `gpt-relay projects discover` to preview or add `--save` to merge names into the local catalog. The scanner never sends messages, navigates or expands sections. Reveal the Projects section before scanning if it is hidden. Results always report partial coverage; unreadable tabs and conflicting names are reported without deleting existing catalog entries.

## Load the extension

1. Open `edge://extensions/` in Edge or `chrome://extensions/` in Chrome.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose the repository's `extension/` directory.
4. Open or refresh `https://chatgpt.com/`.
5. Confirm that a green `Relay: <session-id>` banner appears.
6. Select the extension icon to inspect relay health, sessions, and recent
   tasks.

## Reload after a code change

1. Open `edge://extensions/` in Edge or `chrome://extensions/` in Chrome.
2. Find gpt-relay and select **Reload**.
3. Refresh every `chatgpt.com` tab that should run the updated content script.

## Browser window guidance

- For reliable parallel sessions, keep each session in a browser window that is
  not minimized. Chromium may throttle or freeze timers, observers, and page
  scheduling in minimized or occluded windows.
- Windows can overlap, remain small, or stay on a secondary display.
- If fully occluded windows are still throttled, launch Chromium with
  `--disable-features=CalculateNativeWinOcclusion`.

## Popup

- Health indicator: green when the relay is reachable, red otherwise.
- Sessions: each connected ChatGPT tab, its server-side status, queued count,
  active task status (including `recovering`), and page readiness reason with
  user/assistant DOM counts. `script unavailable` means the content script did
  not respond; `conversation-hydrating (u0/a0)` means the existing chat's
  message history has not been detected, so dispatch remains safely queued.
  An attached payload is shown as `attachment · Send enabled` or `uploading ·
  Send disabled` without displaying its filename or content.
- Recent tasks: status and duration for the latest eight tasks.
- Relay URL: defaults to `http://127.0.0.1:8765`.
- **Poll now**: requests an immediate poll instead of waiting for the next
  scheduled alarm.
- **Clear inflight**: emergency cleanup for local in-flight, pending-reply, and
  attachment-block state.

## Permissions

- `storage`: stores the relay URL, in-flight task map, pending replies, tab to
  session mapping, attachment-cleanup blocks, and recent errors.
- `alarms`: wakes the MV3 service worker for background polling.
- `tabs` and `scripting`: communicates with content scripts in ChatGPT tabs.
- `notifications`: reserved for future use.
- `host_permissions`: limited to `chatgpt.com` and the local relay.

## Architecture

```text
Agent -> POST /v1/tasks -> Relay server (Express + SQLite)
                                 ^
                            HTTP long poll
                                 v
                       Extension service worker
                                 |
                      chrome.tabs.sendMessage
                                 v
                     Content script in ChatGPT
                                 |
                           DOM interaction
                                 v
                        ChatGPT web interface
```

- The **content script** performs synchronous page operations: inject the
  prompt, select send, and snapshot replies. It recognizes both the older
  message-role attributes and the newer Project conversation units marked by
  `data-content-search-unit-key`, `data-user-message-bubble`, and
  `data-conversation-role`. Send is selected only inside the composer.
- The **service worker** drives the lifecycle:
  - waits for the document, conversation history, composer, and message baseline
    to stabilize before claiming work;
  - long-polls `/internal/next_task`;
  - persists a send-attempt fence in browser storage and SQLite before allowing the content script to select Send;
  - keeps the normal Send-ready wait at 15 seconds, but allows up to 90 seconds
    when a large paste becomes a ChatGPT attachment;
  - sends `run-task` to the content script;
  - records the task in its persistent pending-reply state;
  - samples the page every two seconds and completes the task after the reply is
    stable;
  - reports only bounded phase, visible activity, and output-size observations
    to server memory, at most every 10 seconds for changes or 30 seconds for an
    unchanged heartbeat; partial reply text is never uploaded as progress;
  - after the soft deadline, renews a bounded recovery lease only while strong
    evidence for the original task remains visible.
- Durable extension state lives in `chrome.storage.local`, including
  `inflight`, `pending_replies`, and `tab_session_map`.

## Recovery behavior

| Scenario | Recovery owner | Behavior |
|---|---|---|
| Agent client exits | Relay server | Task remains in SQLite and can be retrieved later |
| ChatGPT page reloads | Service worker | Reconciles server, browser, and page state; reattaches or captures output without replaying a post-attempt prompt |
| Service worker sleeps | Service worker | Loads `pending_replies` at the next alarm and resumes sampling |
| Extension or browser restarts | Service worker reconciliation | Restores the durable send fence before claiming more work and removes terminal orphan records |
| Network changes | Content script | Observes connectivity and repeated request failures and reloads when needed |

The browser path provides at-most-once automatic delivery. Once `send_attempted` has been durably recorded, an empty or still-hydrating DOM is treated as unknown evidence and never makes the task resendable. When the normal task lifetime plus active grace passes, the server exposes non-terminal `recovering` instead of immediately failing the task. A reply captured in that state completes normally and is stored as `reply`.

Active generation or the exact submitted user message with no reply is strong recovery evidence. The extension reports that observation at a bounded cadence, renewing a short server lease. A generic heartbeat, history hydration, or empty DOM does not renew it. Recovery ends on a reply, explicit Stop/cancel, session heartbeat loss, lease expiry, or the absolute recovery deadline.

Provisional progress is a separate observability path. It is kept only in relay
server memory and helps clients decide when to observe again. It does not renew
the recovery lease and is cleared when the task becomes terminal.

A recovering task reserves the session. A visible submitted message continues to block until a terminal transition, and active generation always blocks. An unacknowledged Send fence gets a fixed two-minute verification window that queued successors cannot shorten. A fully observed idle page plus recorded composer residue becomes `submission_not_observed`; missing or ambiguous page evidence becomes `submission_outcome_unknown`. Advancing never requeues or resends the original task. A reply discovered after either eligible terminal result can still be stored as `lateReply` during the remaining bounded window.

Before each new dispatch, the content script spends up to three seconds trying
to remove stale text and attachments. It selects existing text before injection,
so the new prompt replaces old text rather than appending to it. This reset is
best effort: incomplete cleanup is logged but does not block Send. Failure paths
make the same bounded cleanup attempt after first recording whether composer
payload was present for the submission verdict.

See [`task-lifecycle.md`](../task-lifecycle.md) for the complete state diagram,
lease rules, and Agent behavior.

## Large-paste attachments

ChatGPT can convert a large pasted prompt into a text attachment and leave the
composer itself empty. The extension treats an enabled Send button as the final
readiness signal. Ordinary text gets a 15-second Send-ready budget; a detected
attachment, upload indicator, or large-paste-to-empty-composer transition gets
up to 90 seconds. The service worker allows 120 seconds for the complete
content-script submission acknowledgement.

If upload fails or does not enable Send within that window, the task fails with
`attachment_upload_failed` or `attachment_upload_timeout`. The content script
tries to remove the attachment and clear the composer. If it cannot prove that
the composer is clean, later work is still allowed to proceed; the next dispatch
tries cleanup again and replaces existing text. The failed task is not retried
automatically.

## Sanity check

```bash
# Start the relay.
npm start

# Load extension/ in Chromium and open chatgpt.com.

# In another shell, submit a review.
printf '%s' 'Review this function: function add(a,b){return a+b}' |
  gpt-relay review --session <session-id> --stdin --wait-timeout 60000
```

To exercise recovery, submit a review and refresh the ChatGPT page while it is generating. The extension should recover or reattach to the reply, the conversation should contain exactly one copy of the user prompt, and the task should either complete normally or reach one explicit terminal recovery error. It must never be automatically submitted a second time.

## Thinking effort

`effort-controls.js` loads before the content script and operates only within the target composer. It finds the trigger through `data-composer-navigation-target="reasoning"` and `data-selected-reasoning-effort`, links menus through runtime ARIA IDs, and operates `[data-reasoning-slider]` with bounded left/right keyboard actions. These attributes avoid depending on localized effort labels. Pro is distinguished through `data-maximum`: both Pro and ordinary Medium have raw effort `medium`. Unknown layouts fail closed.

The adapter verifies the selected model family, slider value, raw effort and Pro marker, rechecks after prompt injection, and checks the trigger again immediately before Send. It never opens the model-family selector.

The worker verifies completed effort-enabled replies through a bounded `chrome.scripting.executeScript` call in the MAIN world. Its read-only history request matches the exact submitted user UUID and final assistant UUID and returns only their model and thinking-effort identifiers. Credentials stay in the page; no network interception or additional host permissions are required. Public verification errors and reply retention are defined in [the effort API contract](../api.md#effort-selection); the existing durable Send fence and at-most-once recovery remain in force.
