// extension/popup.js

const el = (id) => document.getElementById(id);

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "popup-get-state" });
  if (!state) return;

  el("baseUrl").value = state.baseUrl;

  let healthy = false;
  let sessions = [];
  let tasks = [];
  try {
    const h = await fetch(`${state.baseUrl}/health`).then((r) => r.json());
    healthy = h?.status === "ok";
    const s = await fetch(`${state.baseUrl}/v1/sessions`).then((r) => r.json());
    sessions = s?.sessions ?? [];
    const t = await fetch(`${state.baseUrl}/v1/tasks?limit=8`).then((r) => r.json());
    tasks = t?.tasks ?? [];
  } catch { /* unreachable */ }

  el("dot").className = "dot " + (healthy ? "ok" : "err");
  const offlineCount = state.offlineSessionCount ?? 0;
  const attachmentBlockCount = Object.keys(state.attachmentBlocks ?? {}).length;
  el("status").textContent = healthy
    ? `${state.baseUrl} · ${sessions.length} active${offlineCount ? ` · ${offlineCount} offline` : ""}${attachmentBlockCount ? ` · ${attachmentBlockCount} attachment-blocked` : ""}`
    : `${state.baseUrl} · unreachable`;

  const sessTbody = el("sessions").querySelector("tbody");
  sessTbody.innerHTML = "";
  for (const tab of state.tabs) {
    const tr = document.createElement("tr");
    const server = sessions.find((x) => x.session === tab.session);
    if (server?.paused) tr.classList.add("paused");
    if (tab.offline) tr.classList.add("offline");
    const inflight = state.inflight[tab.session];
    const attachmentBlock = state.attachmentBlocks?.[tab.session];
    if (attachmentBlock) tr.classList.add("paused");
    let view = "(not seen)";
    if (tab.offline) view = "offline";
    else if (attachmentBlock) view = `blocked: ${attachmentBlock.reason}`;
    else if (server?.paused) view = `paused: ${server.pauseReason ?? ''}`;
    else if (server) {
      const activeId = server.activeTaskId ?? server.inProgressTaskId;
      const activeStatus = server.activeTaskStatus ?? (activeId ? "in_progress" : null);
      view = `pending=${server.pendingTasks}` +
        (activeId ? ` · active=${activeStatus}:${activeId.slice(0, 8)}` : "");
    }
    const page = tab.page;
    const pageView = !tab.session || !page ? "script unavailable" :
      page.session !== tab.session ? "session mismatch" :
      page.ready ? `ready (u${page.userCount}/a${page.assistantCount})` :
      `${page.reason ?? "not ready"} (u${page.userCount}/a${page.assistantCount})`;
    tr.innerHTML = `
      <td class="mono" title="${tab.session ?? ''}">${(tab.session ?? '?').slice(0, 12)}…</td>
      <td>${pageView}</td>
      <td>${view}</td>
      <td class="mono">${inflight ? inflight.taskId.slice(0, 8) : ""}</td>
    `;
    sessTbody.appendChild(tr);
  }
  if (state.tabs.length === 0) {
    sessTbody.innerHTML = `<tr><td colspan="4" style="color:#999">no chatgpt.com tabs open</td></tr>`;
  }

  const taskTbody = el("tasks").querySelector("tbody");
  taskTbody.innerHTML = "";
  for (const t of tasks) {
    const tr = document.createElement("tr");
    const elapsed = t.completedAt ? t.completedAt - t.submittedAt : Date.now() - t.submittedAt;
    tr.innerHTML = `
      <td class="mono">${t.taskId.slice(0, 8)}</td>
      <td class="mono">${t.session.slice(0, 10)}</td>
      <td>${t.status}</td>
      <td>${Math.round(elapsed / 1000)}s</td>
    `;
    taskTbody.appendChild(tr);
  }

  if (state.lastError) {
    el("lastErrorSection").hidden = false;
    el("lastError").textContent =
      `[${new Date(state.lastError.at).toLocaleTimeString()}] ${state.lastError.taskId?.slice(0, 8) ?? '?'}\n${state.lastError.error}`;
  }
}

el("saveUrl").addEventListener("click", async () => {
  const baseUrl = el("baseUrl").value.trim().replace(/\/$/, "");
  await chrome.runtime.sendMessage({ type: "popup-set-base-url", baseUrl });
  await refresh();
});

el("pollNow").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup-poll-now" });
  setTimeout(refresh, 300);
});

el("clearInflight").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup-clear-inflight" });
  setTimeout(refresh, 200);
});

refresh();
setInterval(refresh, 3000);
