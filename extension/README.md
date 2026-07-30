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
- Sessions: each connected ChatGPT tab, its server-side status, and in-flight
  task.
- Recent tasks: status and duration for the latest eight tasks.
- Relay URL: defaults to `http://127.0.0.1:8765`.
- **Poll now**: requests an immediate poll instead of waiting for the next
  scheduled alarm.
- **Clear inflight**: emergency cleanup for local in-flight and pending-reply
  extension state.

## Permissions

- `storage`: stores the relay URL, in-flight task map, pending replies, tab to
  session mapping, and recent errors.
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
  - sends `run-task` to the content script;
  - records the task in its persistent pending-reply state;
  - samples the page every two seconds and completes the task after the reply is
    stable.
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

The browser path provides at-most-once automatic delivery. Once `send_attempted` has been durably recorded, an empty or still-hydrating DOM is treated as unknown evidence and never makes the task resendable. If submission cannot be confirmed before the task deadline or before safely advancing queued work, the task fails with `submission_outcome_unknown`; a reply discovered while its observer remains active during the late-reply window is stored as `lateReply`.

Late-reply observation does not reserve a session indefinitely. When a recovered delivery remains unconfirmed, the page is fully hydrated and stably idle, and newer work is queued, the extension ends the ambiguous observation with `submission_outcome_unknown` and advances the queue. A visible submitted user message continues to block until its hard deadline, and active generation always blocks. Advancing the queue never requeues or resends the uncertain task.

## Sanity check

```bash
# Start the relay.
npm start

# Load extension/ in Chromium and open chatgpt.com.

# In another shell, submit a review.
printf '%s' 'Review this function: function add(a,b){return a+b}' |
  gpt-relay review --session <session-id> --stdin --wait-timeout 60000
```

To exercise recovery, submit a review and refresh the ChatGPT page while it is generating. The extension should recover or reattach to the reply, the conversation should contain exactly one copy of the user prompt, and the CLI should eventually receive either the completed task or an explicit `submission_outcome_unknown` failure.
