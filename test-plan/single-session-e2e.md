# Single-session manual E2E test plan

This plan covers core behavior in one real ChatGPT session and tab. Every case
uses a real browser, ChatGPT page, extension, and relay server.

## Prerequisites

1. Start the relay with `npm start` or `npx tsx server/index.ts`.
2. Load the gpt-relay extension and configure the correct `GPT_RELAY_URL`.
3. Keep one `chatgpt.com` tab visible and record its session ID.
4. Confirm that the session is not paused and has no in-flight task.
5. Keep the extension service-worker console and ChatGPT page console available
   for diagnostics.

## Test matrix

| ID | Case | Priority | Related automated coverage |
|---|---|---|---|
| SS-001 | Basic short-text round trip | P0 | `review round-trip via fake extension` |
| SS-002 | Submit 35k+ text as an attachment | P0 | Long-text path |
| SS-003 | Resume after a client wait timeout | P0 | `client wait timeout then resume gets reply` |
| SS-004 | Inspect a `--no-wait` submission | P0 | `resume returns already-done task` |
| SS-005 | Cancel a queued task | P1 | `cancel queued task prevents processing` |
| SS-006 | Cancel an in-progress task | P1 | `cancel in-progress task` |
| SS-007 | Expire a task with a short timeout | P1 | `task expires when timeout is too short` |
| SS-008 | Preserve special characters and multiline text | P1 | `special characters and multiline text` |
| SS-009 | Recover after refreshing the ChatGPT page | P0 | `recover flow: task in_progress -> page reload` |
| SS-010 | Recover after reloading the extension | P0 | `fake extension recovers after restart` |
| SS-011 | Recover after a network interruption | P1 | `offline/online` handler |
| SS-012 | Pause a session after a safety block | P1 | `pause via session_status` |
| SS-013 | Retry after task execution failure | P1 | `requeueTask over limit` |
| SS-014 | Reject empty text and accept very short text | P2 | Input validation |
| SS-015 | Allow a five-minute task timeout | P2 | Timeout lifecycle |

## SS-001: Basic short-text round trip

Purpose: verify the simplest complete path.

Steps:

1. Run:
   `npx tsx bin/gpt-relay.ts review --session <session-id> --text "hello" --wait-timeout 30000`
2. Observe the CLI and ChatGPT page.
3. Confirm that the prompt is inserted, Send is selected, and a new assistant
   message appears.
4. Confirm that the relay banner progresses from ready to submitting, waiting,
   and ready.

Expected:

- The CLI prints a non-empty reply within 30 seconds.
- The final status is `done`.
- `dispatchedAt - submittedAt` is less than one second under normal local
  conditions.

## SS-002: Submit 35k+ text as an attachment

Purpose: verify ChatGPT's automatic pasted-text attachment path.

Steps:

1. Generate a text file containing at least 35,000 characters.
2. Run:
   `npx tsx bin/gpt-relay.ts review --session <session-id> --file long.txt --wait-timeout 120000`
3. Confirm that the page shows a pasted-text attachment and enables Send after
   upload.

Expected:

- The task finishes as `done`.
- The reply acknowledges the submitted text or attachment.
- Completion may take 10 to 30 seconds depending on upload and response time.

## SS-003: Resume after a client wait timeout

Purpose: verify that ending one client wait does not lose the server task.

Steps:

1. Submit a prompt that should take longer than three seconds to answer.
2. Pass `--wait-timeout 3000` and confirm that the CLI wait times out.
3. Wait for ChatGPT to finish.
4. Run `npx tsx bin/gpt-relay.ts resume`.

Expected:

- The initial CLI call reports a wait timeout.
- `resume` reports `done` and prints the reply.
- The pending record is removed after recovery.

## SS-004: Inspect a `--no-wait` submission

Purpose: verify non-blocking submission and later retrieval.

Steps:

1. Run:
   `npx tsx bin/gpt-relay.ts review --session <session-id> --text "no wait test" --no-wait`
2. Save the returned `taskId`.
3. Wait for completion.
4. Query `/v1/tasks/<task-id>` or run
   `npx tsx bin/gpt-relay.ts show <task-id>`.
5. Run `npx tsx bin/gpt-relay.ts resume`.

Expected:

- Submission immediately returns a queued task ID.
- Later inspection reports `done` with a reply.
- `resume` reports the same result and removes the pending record.

## SS-005: Cancel a queued task

Purpose: confirm that cancellation before claim prevents page submission.

Steps:

1. Stop the target extension dispatch loop or otherwise keep it from claiming.
2. Submit `"cancel me"` with `--no-wait`.
3. Immediately run `npx tsx bin/gpt-relay.ts cancel <task-id>`.
4. Restore the extension and inspect the task after five seconds.

Expected:

- Cancellation returns `cancelled`.
- The prompt never appears in ChatGPT.
- The task remains `cancelled`.

## SS-006: Cancel an in-progress task

Purpose: confirm cancellation after the extension claims a task.

Steps:

1. Submit a slow prompt with `--no-wait`.
2. Wait until `/v1/tasks/<task-id>` reports `in_progress`.
3. Run `npx tsx bin/gpt-relay.ts cancel <task-id>`.
4. Inspect the final task and page banner.

Expected:

- The final task status is `cancelled`.
- The page's in-flight banner state is cleared.

## SS-007: Expire a task with a short timeout

Purpose: verify queued-task deadline handling.

Steps:

1. Stop extension claiming.
2. Submit with `--no-wait --task-timeout 2000`.
3. Wait at least five seconds.
4. Inspect the task.

Expected:

- Status is `expired`.
- `error` is `task_expired_before_dispatch`.

## SS-008: Preserve special characters and multiline text

Purpose: verify Unicode, emoji, newlines, markup, quoting, and backslashes.

Steps:

1. Create a file containing mixed ASCII, CJK, emoji, tabs, quotes, markup,
   backslashes, and CRLF/LF newlines.
2. Submit it through `--file`.
3. Compare the prompt displayed in ChatGPT with the source file.

Expected:

- Content is preserved.
- The task finishes as `done` with a normal reply.

## SS-009: Recover after refreshing the ChatGPT page

Purpose: verify in-flight recovery during generation.

Steps:

1. Submit a slow prompt.
2. Wait until the banner reports that it is waiting for a reply.
3. Refresh the ChatGPT page.
4. Wait for hydration and continued generation.

Expected:

- The relay banner reappears and enters recovery or waiting state.
- The task finishes without client resubmission.
- The prompt is not submitted twice.

## SS-010: Recover after reloading the extension

Purpose: verify reinjection and dispatch-loop recovery.

Steps:

1. Select **Reload** for gpt-relay in `chrome://extensions/`.
2. Refresh the ChatGPT tab.
3. Submit a short prompt.

Expected:

- The content script reports the session again.
- The service worker restarts its dispatch loop.
- The task is claimed promptly and finishes as `done`.

## SS-011: Recover after a network interruption

Purpose: verify temporary ChatGPT connectivity loss.

Steps:

1. Submit a prompt.
2. Set the ChatGPT tab to **Offline** in browser developer tools or disconnect
   the network.
3. Wait five seconds, then restore connectivity.

Expected:

- The extension avoids dispatching new work while offline.
- Processing resumes after connectivity returns.
- The task either completes or ends with an explicit, reasonable failure.

## SS-012: Pause a session after a safety block

Purpose: verify captcha, rate-limit, and safety pause behavior.

Steps:

1. Use a controlled test condition that causes a supported safety warning.
2. Confirm that the banner reports the pause reason.
3. Attempt to submit another task.
4. Resolve the warning, resume, and submit again.

Expected:

- The server reports `paused: true`.
- New submissions return `409 session_paused`.
- Processing resumes only after the block is resolved.

Do not intentionally violate service policies to provoke this test.

## SS-013: Retry after task execution failure

Purpose: verify bounded requeue behavior after a transient content-script
failure.

Steps:

1. Submit a task.
2. Refresh the page or interrupt the content script at the run-task boundary.
3. Observe state transitions and wait for recovery.

Expected:

- The task may return to `queued` for retry.
- Requeue count does not exceed the configured limit.
- The task eventually becomes `done` or definitively `failed`.

## SS-014: Reject empty text and accept very short text

Steps:

1. Submit an empty string.
2. Submit `"hi"`.
3. Submit `"?"`.

Expected:

- Empty text returns `400 missing text`.
- Very short non-empty prompts complete normally.

## SS-015: Allow a five-minute task timeout

Steps:

1. Submit a prompt that may take an extended time.
2. Use `--wait-timeout 300000 --task-timeout 300000`.
3. Wait for completion.

Expected:

- The task does not expire early.
- It finishes as `done` with a reply.

## Execution guidance

- Treat SS-001, SS-002, SS-003, SS-009, and SS-010 as the core regression set.
- Before each run, use `npx tsx bin/gpt-relay.ts sessions` to confirm that no
  unexpected task is in flight.
- Allow margin for variable ChatGPT response times.
- Inspect the service-worker and page consoles first when diagnosing a failure.
