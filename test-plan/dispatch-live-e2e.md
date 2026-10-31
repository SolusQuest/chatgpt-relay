# Unified dispatch: live ChatGPT validation

Validated on 2026-10-31 against the installed Edge extension, the launchd-managed Relay service, and real ChatGPT conversations. This complements the isolated transport harness in [dispatch-browser-e2e.md](dispatch-browser-e2e.md).

## Procedure and safeguards

Before restarting the service or extension, check queued, in-progress and recovering tasks, then inspect page readiness, generation and composer state. Preserve pages with drafts or attachments. Back up the live SQLite database before the first service restart. Use fresh test conversations with unique, short exact-response prompts; retain task IDs and client request IDs throughout recovery. Never resubmit an uncertain Send.

An unrelated Relay started during validation. The final pre-reload activity check detected it and aborted the reload before changing the running extension. Subsequent checks were read-only while that task ran.

## Observed results

- Eight Relay tasks across four test conversations completed with the expected exact replies. One conversation was created manually in the page and then reused by Relay; its policy remained `manual` / `protected`.
- Two queued messages in the same conversation executed in order: the second claim occurred after the first completion. Execution intervals in different conversations overlapped.
- A normal ChatGPT homepage reported `session: null`, `pageKind: discovery`, and was absent from the server session list until a real conversation was created there.
- A CLI refresh operation on an idle test page succeeded. New content scripts advertised dispatch protocol 2 and control protocol 1. CLI diagnostics and the popup reported a connected dispatcher.
- Restarting the real service after one test task's durable Send fence preserved that task. It completed with the expected reply; the page contained exactly the expected two user turns and two assistant turns.
- The first message in a new conversation displayed `Waiting for reply`, busy state, and blue `#3498db`; completion returned the widget to idle green.
- Temporarily setting the managed-page limit to 2 reclaimed the oldest eligible idle test page. A later task reopened that original conversation and completed without another user turn being added for the same task. The default limit was restored to 6.
- The reopened page temporarily rendered empty assistant bodies, including historical replies. Relay retained the original task and waited; the expected reply was eventually captured. A requested recovery refresh was rejected as `task_not_recoverable` because the task had already completed. This was not evidence of a successful recovery refresh.

## Regression found during the live test

A new conversation occasionally lost its Relay lifecycle ownership during the initial route/binding transition, changing from `relay` / `reclaimable` to `manual` / `protected`. Its task still completed, but capacity undercounted that page. The original live run therefore did **not** fully validate the capacity invariant.

The fix fences per-tab registration results and storage writes, validates document identity before applying registration, preserves a token-validated unbound creation through transient null identity, and prevents stale null cleanup or binding responses from overwriting newer state. Genuine manual navigation still releases the prior ownership.

Seven deterministic regressions were added. The resulting full suite passed **639/639**, TypeScript checking passed, and public-release hygiene checking passed. The final isolated Edge MV3 run passed **12 sessions / 14 tasks**, with one synthetic Send per task, zero legacy next-task calls, and a maximum server watch cancellation overlap of 5 ms. This isolated run covers transport/recovery; its synthetic content script does not exercise real ChatGPT route transitions.

## Live retest after the fix

After the unrelated Relay completed normally, repeat checks confirmed no queued, executing or recovering tasks and clean, idle pages. The extension was reloaded and the idle pages refreshed; no active task was interrupted.

The managed-page limit was temporarily set to the then-current count of 3. Creating test conversation D reclaimed old test B. D retained `reclaimable` through its transient discovery observation and final conversation binding, and the popup continued to count 3 managed pages. Submitting a task to parked B then reclaimed old test A and reopened B with its original conversation ID and `reclaimable` policy. The unrelated user's conversation stayed open throughout both operations. The limit was restored to 6.

Both retest tasks completed with their exact expected replies, bringing the live total to **10/10 successful Relay tasks** across five test conversations, plus the manual seed turn. Completed test and diagnostic tabs were cleaned up after checking that their sessions were idle; conversation history was retained. The updated service and extension remained running.
