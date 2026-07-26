# Multi-session manual E2E test plan

This plan covers concurrency, isolation, and resource contention across multiple
real ChatGPT sessions and tabs.

## Prerequisites

1. Start the relay server.
2. Keep at least two different ChatGPT conversations visible and record their
   session IDs as `session-a` and `session-b`.
3. Confirm that both sessions are unpaused and have no in-flight tasks.
4. Confirm that the extension is enabled and connected to the relay.

## Test matrix

| ID | Case | Priority | Related automated coverage |
|---|---|---|---|
| MS-001 | Submit one task to each session concurrently | P0 | `two sessions run in parallel` |
| MS-002 | Queue multiple tasks in both sessions | P0 | `multiple tasks per session in parallel across sessions` |
| MS-003 | Pause one session without affecting another | P1 | `pause via session_status` |
| MS-004 | Take one session offline without affecting another | P1 | `offline/online` handler |
| MS-005 | Cancel one task among multiple sessions | P1 | `cancelTask` |
| MS-006 | Deduplicate multiple tabs for one session | P1 | `startDispatchLoop` |
| MS-007 | Replace a dispatch loop after navigation | P1 | `forgetTabSession` and `session-hello` |
| MS-008 | Submit large attachments concurrently | P2 | Long-text and parallel-session paths |
| MS-009 | Resume timed-out waits across sessions | P2 | `client wait timeout then resume` |
| MS-010 | Recover all sessions after relay restart | P2 | `restoreDispatchLoops` and alarms |

## MS-001: Submit one task to each session concurrently

Purpose: verify independent dispatch loops.

Steps:

1. In terminal A, run:
   `npx tsx bin/gpt-relay.ts review --session <session-a> --text "task A" --wait-timeout 30000`
2. At the same time in terminal B, submit `"task B"` to `<session-b>`.
3. Observe both ChatGPT pages.

Expected:

- Both tasks finish as `done`.
- Both `dispatchedAt` timestamps are close to their `submittedAt` timestamps.
- One session never waits for the other's ChatGPT response.

Acceptance:

```text
task-a.status == done
task-b.status == done
task-a.dispatchedAt - task-a.submittedAt < 2000 ms
task-b.dispatchedAt - task-b.submittedAt < 2000 ms
```

## MS-002: Queue multiple tasks in both sessions

Purpose: verify per-session FIFO ordering with cross-session parallelism.

Steps:

1. Submit `task-a0`, `task-a1`, and `task-a2` to session A.
2. Concurrently submit `task-b0`, `task-b1`, and `task-b2` to session B.
3. Use `--no-wait` or sufficiently long timeouts.
4. Wait for all tasks, then run
   `npx tsx bin/gpt-relay.ts tasks --last 20`.

Expected:

- All six tasks finish as `done`.
- Each session completes its tasks in FIFO order.
- Progress in one session does not block the other.

## MS-003: Pause one session without affecting another

Purpose: verify session-level pause isolation.

Steps:

1. Pause session A through `/internal/sessions/<session-a>/status`.
2. Submit to session A and confirm rejection.
3. Submit to session B and confirm normal completion.
4. Resume session A and submit again.

Expected:

- Session A returns `409 session_paused` while paused.
- Session B remains unaffected.
- Session A processes new work after resume.

## MS-004: Take one session offline without affecting another

Purpose: verify that a disconnected or failed tab cannot block other sessions.

Steps:

1. Set session A's ChatGPT page to **Offline** in developer tools.
2. Submit tasks to both sessions.
3. Restore connectivity for session A.

Expected:

- Session B completes normally.
- Session A may fail, defer, or requeue its task explicitly.
- Session A's dispatch loop recovers for later tasks.

## MS-005: Cancel one task among multiple sessions

Purpose: verify task-scoped cancellation.

Steps:

1. Submit `a1` and `a2` to session A.
2. Submit `b1` and `b2` to session B.
3. Cancel `a2`.
4. Wait for the remaining tasks.

Expected:

- `a2` is `cancelled`.
- `a1`, `b1`, and `b2` finish normally.

## MS-006: Deduplicate multiple tabs for one session

Purpose: verify that `startDispatchLoop` uses the session as its uniqueness key.

Steps:

1. Open the same ChatGPT conversation in two tabs.
2. Confirm that both report the same session ID.
3. Submit one task to that session.
4. Observe both tabs.

Expected:

- Only one tab inserts and sends the prompt.
- The other remains idle.
- The task completes exactly once.

## MS-007: Replace a dispatch loop after navigation

Purpose: verify session mapping after a tab navigates between conversations.

Steps:

1. Navigate a ChatGPT tab from `/c/<old>` to `/c/<new>`.
2. Confirm that the content script reports the new session ID.
3. Submit to both the new and old session IDs.

Expected:

- The new session task is processed by the navigated tab.
- With no remaining tab, the old session task stays queued and may eventually
  expire.
- The old dispatch loop stops.

## MS-008: Submit large attachments concurrently

Purpose: verify that uploads in separate sessions do not serialize globally.

Steps:

1. Prepare two files containing at least 35,000 characters each.
2. Submit one `--file` task to each session at the same time.
3. Use `--wait-timeout 120000`.

Expected:

- Both tasks finish as `done`.
- Both pages show the attachment path.
- Total duration is comparable to one large-text request rather than their sum.

## MS-009: Resume timed-out waits across sessions

Purpose: verify independent pending records.

Steps:

1. Submit a slow prompt to each session with a three-second client wait.
2. Confirm that both client waits time out.
3. Wait for both page replies.
4. Run `npx tsx bin/gpt-relay.ts resume`.

Expected:

- `resume` reports both completed tasks.
- Each reply belongs to the correct session and task.
- Both pending records are removed.

## MS-010: Recover all sessions after relay restart

Purpose: verify dispatch-loop recovery after the local server restarts.

Steps:

1. Keep session A and B tabs open and visible.
2. Restart the relay process.
3. Select **Poll now** in the extension popup, or wait for the recovery alarm.
4. Submit one task to each session.

Expected:

- Both sessions resume heartbeat reporting.
- Both tasks are claimed promptly.
- Both tasks finish as `done`.

## Execution guidance

- Run MS-001 through MS-004 as the primary regression set.
- Confirm both active sessions with
  `npx tsx bin/gpt-relay.ts sessions` before testing.
- Keep real-browser concurrency moderate to avoid account rate limits.
- Inspect the service-worker console and each page console first when
  diagnosing failures.
