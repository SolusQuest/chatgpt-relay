# gpt-relay browser extension

This Chrome-compatible Manifest V3 extension executes relay tasks in the
ChatGPT web interface.

## Load the extension

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose the repository's `extension/` directory.
4. Open or refresh `https://chatgpt.com/`.
5. Confirm that a green `Relay: <session-id>` banner appears.
6. Select the extension icon to inspect relay health, sessions, and recent
   tasks.

## Reload after a code change

1. Open `chrome://extensions/`.
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
  and active task status (including `recovering`).
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
  prompt, select send, and snapshot replies.
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

A recovering task reserves the session. A visible submitted message continues to block until a terminal transition, and active generation always blocks. When a recovered delivery remains genuinely unconfirmed, the page is fully hydrated and stably idle, and newer work is queued, the extension can end the ambiguous observation with `submission_outcome_unknown` and advance the queue. Advancing never requeues or resends the uncertain task. A reply discovered after an eligible early terminal failure can still be stored as `lateReply` during the remaining bounded window.

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
the composer is clean, the extension pauses that session while preserving
already queued successors. Remove the unfinished attachment manually; the
extension resumes automatically after it observes a clean composer. **Clear
inflight** is the explicit emergency override and also clears this block.

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
