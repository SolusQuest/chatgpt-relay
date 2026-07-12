// extension/popup.js

const el = (id) => document.getElementById(id);

async function refresh() {
  // 从 SW 拉状态
  const state = await chrome.runtime.sendMessage({ type: "popup-get-state" });
  if (!state) return;

  el("baseUrl").value = state.baseUrl;

  // Health
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
  } catch (e) {
    healthy = false;
  }

  el("dot").className = "dot " + (healthy ? "ok" : "err");
  el("status").textContent = healthy
    ? `${state.baseUrl} · ${sessions.length} active`
    : `${state.baseUrl} · unreachable`;

  // Sessions table：按 tab 视角展示
  const sessTbody = el("sessions").querySelector("tbody");
  sessTbody.innerHTML = "";
  for (const tab of state.tabs) {
    const tr = document.createElement("tr");
    const server = sessions.find((x) => x.session === tab.session);
    if (server?.paused) tr.classList.add("paused");
    const inflight = state.inflight[tab.session];
    tr.innerHTML = `
      <td class="mono" title="${tab.session ?? ''}">${(tab.session ?? '?').slice(0, 12)}…</td>
      <td>${
        !server ? "(not seen)" :
        server.paused ? `paused: ${server.pauseReason ?? ''}` :
        `pending=${server.pendingTasks}`
      }</td>
      <td class="mono">${inflight ? inflight.taskId.slice(0, 8) : ""}</td>
    `;
    sessTbody.appendChild(tr);
  }
  if (state.tabs.length === 0) {
    sessTbody.innerHTML = `<tr><td colspan="3" style="color:#999">no chatgpt.com tabs open</td></tr>`;
  }

  // Tasks
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

  // Last error
  if (state.lastError) {
    el("lastErrorSection").hidden = false;
    el("lastError").textContent =
      `[${new Date(state.lastError.at).toLocaleTimeString()}] ${state.lastError.taskId?.slice(0,8) ?? '?'}\n${state.lastError.error}`;
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

refresh();
setInterval(refresh, 3000);