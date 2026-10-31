// extension/popup.js

const el = (id) => document.getElementById(id);

function showActionError(error) {
  el("actionError").hidden = !error;
  el("actionError").textContent = error ? String(error.message ?? error) : "";
}
async function sendSetting(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || response.error || response.ok === false) throw new Error(response?.error ?? "Settings could not be saved");
  return response;
}
async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "popup-get-state" });
  if (!state) return;

  if (document.activeElement !== el("baseUrl")) el("baseUrl").value = state.baseUrl;
  if (document.activeElement !== el("maxManagedTabs")) el("maxManagedTabs").value = state.capacity?.maxManagedTabs ?? 6;
  const dispatch = state.dispatch;
  el("dispatchStatus").textContent = `Dispatch: ${dispatch?.state ?? "legacy"}${dispatch?.lastError ? ` · ${dispatch.lastError}` : ""}`;
  el("dispatchStatus").title = dispatch?.lastConnectedAt ? `Last connected: ${new Date(dispatch.lastConnectedAt).toLocaleString()}` : "";
  const capacity = state.capacity;
  el("capacityStatus").textContent = capacity ? `Managed tabs: ${capacity.managedCount}/${capacity.maxManagedTabs} · available: ${capacity.available} · waiting: ${capacity.waiting?.length ?? 0}` : "Managed tab limit: 6 (default)";
  el("capacityStatus").title = capacity?.waiting?.join(", ") ?? "";

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
    const inflight = state.inflight?.[tab.session];
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
    const pageView = !tab.session ? `discovery (${tab.pageKind ?? "home"})` : !page ? "page snapshot unavailable" :
      page.session !== tab.session ? "session mismatch" :
      page.ready ? `ready (u${page.userCount}/a${page.assistantCount})` :
      `${page.reason ?? "not ready"} (u${page.userCount}/a${page.assistantCount})`;
    const attachmentView = page?.session === tab.session && page.attachmentPresent
      ? ` · ${page.uploading ? "uploading" : "attachment"} · Send ${page.sendEnabled ? "enabled" : "disabled"}`
      : "";
    for (const [index, value] of [(tab.session ?? "discovery").slice(0, 12), `${pageView}${attachmentView}`, view, inflight ? inflight.taskId.slice(0, 8) : ""].entries()) {
      const td = document.createElement("td");
      td.textContent = value;
      if (index === 0 || index === 3) td.className = "mono";
      if (index === 0) td.title = tab.session ?? "Discovery page";
      tr.appendChild(td);
    }
    const policyCell = document.createElement("td");
    const select = document.createElement("select");
    select.setAttribute("aria-label", `Page policy for ${tab.session ?? "discovery"}`);
    for (const [value, label] of [["protected", "Protected"], ["reclaimable", "Reclaimable"]]) {
      const option = document.createElement("option");
      option.value = value; option.textContent = label; select.appendChild(option);
    }
    select.value = tab.lifecyclePolicy === "reclaimable" ? "reclaimable" : "protected";
    select.disabled = !tab.session;
    select.title = tab.session ? "Reclaimable grants permission to close this page when idle" : "Discovery pages are protected";
    select.addEventListener("change", async () => {
      select.disabled = true;
      try {
        await sendSetting({type:"popup-set-page-policy",tabId:tab.tabId,lifecyclePolicy:select.value});
        showActionError(null);
      } catch (error) { showActionError(error); }
      await safeRefresh();
    });
    policyCell.appendChild(select); tr.appendChild(policyCell);
    sessTbody.appendChild(tr);
  }
  if (state.tabs.length === 0) {
    sessTbody.innerHTML = `<tr><td colspan="5" style="color:#999">no chatgpt.com tabs open</td></tr>`;
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

  el("lastErrorSection").hidden = !state.lastError;
  if (state.lastError) {
    el("lastErrorSection").hidden = false;
    el("lastError").textContent =
      `[${new Date(state.lastError.at).toLocaleTimeString()}] ${state.lastError.taskId?.slice(0, 8) ?? '?'}\n${state.lastError.error}`;
  }
}

async function safeRefresh() {
  try { await refresh(); } catch (error) { showActionError(error); }
}
el("saveCapacity").addEventListener("click", async () => {
  const maxManagedTabs = Number(el("maxManagedTabs").value);
  if (!Number.isInteger(maxManagedTabs) || maxManagedTabs < 1 || maxManagedTabs > 100) {
    showActionError("Managed tab limit must be a whole number from 1 to 100"); return;
  }
  try {
    await sendSetting({type:"popup-set-capacity",maxManagedTabs});
    showActionError(null); await safeRefresh();
  } catch (error) { showActionError(error); }
});
el("saveUrl").addEventListener("click", async () => {
  const baseUrl = el("baseUrl").value.trim().replace(/\/$/, "");
  try {
    await sendSetting({ type: "popup-set-base-url", baseUrl });
    showActionError(null); await safeRefresh();
  } catch (error) { showActionError(error); }
});

el("pollNow").addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "popup-poll-now" });
    setTimeout(safeRefresh, 300);
  } catch (error) { showActionError(error); }
});

el("clearInflight").addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "popup-clear-inflight" });
    setTimeout(safeRefresh, 200);
  } catch (error) { showActionError(error); }
});

safeRefresh();
setInterval(safeRefresh, 3000);
