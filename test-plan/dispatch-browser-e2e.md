# Unified dispatch: isolated Edge MV3 transport validation

Validated on 2026-10-31 with Microsoft Edge headless and a fresh temporary browser profile. This is a **synthetic extension transport test**, not a ChatGPT DOM or real conversation test.

## Isolation and fixture

The reproducible harness is `scripts/test-browser-dispatch.mjs`. Run it from the repository root:

```sh
node --import tsx scripts/test-browser-dispatch.mjs
```

On macOS it defaults to the standard Microsoft Edge application executable. Set `RELAY_TEST_EDGE_BIN` to an Edge executable to override that path; this variable is required on other platforms. The harness prints its temporary artifact directory and a `report.json` path, preserving the temporary profile/database for inspection.

The harness copies the current unpacked extension into a newly created `relay-dispatch-browser-e2e.*` directory under the operating system temporary directory, creates a temporary SQLite database, and starts `createApp` on an ephemeral localhost port. Edge receives a separate `--user-data-dir`, `--load-extension`, and `--disable-extensions-except` pointing only at that copy. It never opens or reloads the installed extension, existing browser profile, or live relay server.

Only the temporary copy changes: its tab-query URL filter and content-script matches point to the local fixture origin, its host permissions include localhost, and a test-only global hook initializes the existing worker dispatch client after setting local extension configuration. A synthetic content script advertises control protocol 1 and dispatch protocol 2, answers session identity/readiness, invokes the real worker `send-attempted` message, counts one synthetic Send after the durable fence, and returns stable synthetic reply observations. It does not manipulate ChatGPT, send real prompts, or test the production content script. Normal browser traffic uses an unreachable localhost proxy with localhost bypass; no ChatGPT pages are opened or fetched by the fixture. Edge background updater diagnostics are outside the test's assertions.

## Scenarios and assertions

1. Open 12 distinct local session pages in real Edge MV3, submit one durable server task per session, and observe claim → Send fence → reply capture → `done` through the actual worker and server APIs.
2. Detach the worker's CDP debugging session, explicitly stop its service worker with `ServiceWorker.stopWorker`, detach the page CDP session, then submit another queued task. The fixture's normal extension messages wake the worker; the task completes.
3. Start another task, hold its synthetic reply in `generating`, and wait until its synthetic Send is recorded. Close only the temporary backend's connections/listener, wait, and rebind the same temporary backend port. Release the reply fixture and verify the original task completes without another Send.
4. Count all backend requests: no legacy `/internal/next_task`, one client watch loop, allowing brief server-side overlap while an aborted request closes, and exactly one synthetic Send per task.

CDP is detached while waiting for dispatch/recovery. The service-worker test is an explicit forced stop; it does **not** establish natural MV3 idle suspension behavior. Closing/rebinding the backend listener tests transport disconnection, not a full server-process/SQLite reopen. Durable claim restart and lost-response cases are covered separately in `test/dispatch.test.ts`.

## Recorded result

Latest run: **PASS**, 12 sessions, 14 completed tasks, 14 captures, 14 unique tasks each with exactly one synthetic Send. The portable harness rerun observed a maximum of **2** server-side watch requests with **4 ms** overlap during cancellation/replacement, **0** legacy next-task calls, 61 watch requests across membership/task/recovery changes, and 25 claim requests (including empty/idempotent checks). The progress-request counter was 56; it includes all progress phases, not 56 Send fences.

The harness prints the ephemeral profile/database directory and backend port for each run. All browser and server processes started by the harness are stopped afterward. The JSON report and profile/database artifacts remain available at the printed paths for inspection.

Expected non-success HTTP observations were favicon 404s and unregistered manual-session inspection 404s; the worker intentionally falls back to the fixture's conversation identity for the latter. An earlier run measured a maximum of one server-side watch. The harness records cancellation overlap separately: it rejects more than two concurrent server requests or an overlap longer than 500 ms, distinguishing a canceled request being torn down from sustained duplicate watches. It does not claim that transient transport overlap is impossible.

The harness also reports `queueClaimLatencyMs` from durable `dispatchedAt - submittedAt`, separately for cold fixture pages, the restarted worker, and the task whose backend disconnect occurs after Send. Reading the final run's preserved SQLite database gave cold-page latencies of 88–107 ms (median 99 ms, mean 97 ms, 12 tasks), restarted-worker latency 1,487 ms (one task), and 12 ms for the task later disconnected after Send. The latter measures its initial claim, not reconnect latency. These are local synthetic transport observations, not ChatGPT latency estimates.
