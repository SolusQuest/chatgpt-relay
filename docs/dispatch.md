# Unified browser dispatch

A server advertising `capabilities.dispatchV2: true` supports one bounded watch per backend and extension instance. `/internal/dispatch/watch` waits at most 20 seconds and returns a cursor, session queue/active state, and pending creation, control and discovery commands. A changed server epoch requires resynchronization. Legacy servers retain the older polling path; mode selection prevents both paths from claiming the same session.

Watch observes work; `/internal/dispatch/claim` durably reserves it. The worker persists the request ID before claiming. Repeating that request returns its original result rather than consuming the next task. A claim token binds execution to owner, worker generation, tab and document. Before Send, the server validates that identity and the existing durable Send fence still applies. Worker restart uses `/internal/dispatch/resume` to reconcile the original request; uncertain transport and lost page evidence never authorize another prompt after `send_attempted`.

The popup shows dispatch connection health separately from relay health and page evidence. Batched snapshots retain their observation time and a separate receipt time; delayed delivery does not make an old page sample fresh. `page_snapshot_stale` and `page_snapshot_unknown` are missing evidence. `page_probe_failed` requires a recent explicit failed probe. Browser loading, missing tabs, ambiguous identity and stale instance heartbeats remain separate reasons. Inspection includes `controlsPending`, `latePending` and `activeTaskStatus`; capacity decisions require known safe values and retain pages eligible for late reply capture. Inventory carries bounded waiting-session identifiers; inspection exposes `dispatch.waitingReason: "waiting_for_capacity"`, and doctor reports that code for those sessions. Discovery pages such as ChatGPT home have no registered session and are not classified as unreachable session scripts.

## Managed tab capacity

The popup configures `maxManagedTabs`, default **6**, from **1–100**. The limit bounds Relay-managed conversation tabs. Manual pages start **protected**. Running a review in a manual session does not grant permission to reclaim its tab; the user must explicitly select **Reclaimable** for that page in the popup. Protected and discovery pages are never automatic eviction candidates.

When capacity is full, the worker selects an eligible idle reclaimable page by least recent activity. It requires a unique responsive page, clean composer, no generation, no queued or active tasks, no pending control, and unchanged activity evidence. Automatic close uses the durable close operation and rechecks safety at its execution fence. New work or a policy/activity change blocks removal. If no page is safe, work waits for capacity rather than exceeding the limit or closing a protected page. Lowering the limit does not authorize unsafe removal.

A reclaimed conversation is parked: its session identity and task history remain, and queued work can reopen the same bound conversation when capacity permits. Automatic close gates claims only for the operation's lifetime and preserves any user suspension. Explicit `sessions close` continues to suspend dispatch durably; reopening it requires inspection and explicit `sessions continue`.

## Restart and activation

The MV3 alarm wakes the worker; the worker restores durable requests, inflight Send fences and pending replies before dispatching. A new generation fences old executors. Server restart changes the watch epoch and causes reconciliation against SQLite. Recovery observes the original task and never replays a post-Send prompt.

Unified dispatch requires page evidence `dispatchProtocol: 2`. A new worker with an older page script blocks before claiming and reports `reload_extension_and_page`; legacy dispatch keeps its older compatibility rules. Refresh old ChatGPT pages during an idle window to activate the updated content script.

Backend switching is refused while task evidence or page generation is active. Idle session identity, lifecycle policies, parked conversations and reopen operations are stored under the backend URL in extension storage `backend_state`. Switching back restores that backend’s namespace; parked conversations from another backend never enter the current watch membership. Identity reset preserves the composer.

Source updates do not activate a running relay or extension. Deploy in an idle window: restart the service, reload the extension and refresh relevant ChatGPT pages, then inspect `doctor`, dispatch status and page evidence. Updating these files alone does not restart the service or reload the browser.
