# cgcon Extension (MV3)

Chrome/Edge/Brave 扩展。替代旧版 Tampermonkey 脚本，负责在 chatgpt.com 页面里
执行 relay 分发的 review 任务。

## 加载

1. 打开 `chrome://extensions/`
2. 右上角开启 **开发者模式 (Developer mode)**
3. 点 **加载已解压的扩展程序 (Load unpacked)**，选中 `extension/` 目录
4. 打开或刷新 chatgpt.com 标签页，页面顶部出现绿色 banner `Relay: xxxxxxxx…`
5. 工具栏点扩展图标查看 popup（health / sessions / recent tasks）

## 更新代码后

- `chrome://extensions/` → 找到 cgcon Relay → 点 **刷新 (Reload)** 按钮
- 刷新 chatgpt.com 标签页（让 content-script 重新注入）

## Popup 功能

- 顶部状态灯：绿=relay 健康，红=不可达
- Sessions 表：当前每个 chatgpt tab 的 session、server 视角状态（idle/pending/paused/offline）、in-flight taskId
- Recent tasks 表：最近 8 个 task 状态和耗时
- Relay URL：默认 `http://127.0.0.1:8766`，可改
- Poll now：立即触发一次 poll（跳过 alarm 间隔）
- Clear inflight：应急清空扩展本地 inflight 记录

## 权限说明

- `storage`：保存 relay URL / inflight 表 / 最近错误
- `alarms`：driving 后台 polling
- `tabs` / `scripting`：向 chatgpt.com tab 发消息
- `notifications`：预留（尚未使用）
- `host_permissions` 只覆盖 chatgpt.com 和本地 relay

## 相对旧 Tampermonkey 的改进

| 场景 | Tampermonkey | 扩展 v3 |
|-----|--------------|---------|
| 后台 tab 注入 | `execCommand` 需要 focus | 双路径：focus 时 execCommand，否则 Range + `InputEvent` |
| 断网/VPN 断线 | 需手动刷新页面 | `online`/`offline` 事件 + fetch 观测，连续失败自动 reload |
| 页面刷新丢结果 | 丢 | `sessionStorage` 存 inflight，刷新后自动回捞 DOM 里的回复 |
| 多标签冲突 | 先到先得 | server 侧 partial unique index 强制同 session 唯一 in_progress |
| 更新方式 | @require URL + 版本号 | git pull + Chrome Reload |

## 恢复机制细节

Content-script 提交 task 前会往 `sessionStorage` 写：
```json
{
  "taskId": "...",
  "session": "...",
  "submittedAt": ...,
  "baseline": { "assistantCount": N, "lastAssistantText": "...", "userCount": M, "startedAt": ... }
}
```

页面刷新 / tab 崩溃 / 浏览器重启后，content-script 加载 1.5s 内会：
1. 读该记录，若 session 匹配则进入回捞流程
2. 若 DOM 已比 baseline 多一条 assistant message 且不在生成中 → 抓最后一条，
   POST 到 SW → `/internal/tasks/:id/recover`
3. 若仍在生成中 → 挂 `waitForReply` 继续等
4. 若无新消息 → 请 SW 走 `/internal/tasks/:id/requeue` 打回队列重发

Server 侧 recover 是幂等的：
- task 是 `queued` / `in_progress` → complete（reply 落盘，`recovered: true`）
- task 已是 terminal → 忽略（保留原状态，`recovered: false`）

## 已知限制（Phase 4 版本）

- 图标是 128px 占位纯色版
- 后台 tab 注入路径仍需 ChatGPT 前端接受 `InputEvent`；若前端选择器/事件变化，
  可能需要更新 `content-script.js` 的 selector 或 fallback 顺序
- 一个 session 同时只处理一个 task，多 review 并发需多开 conversation

## Sanity check

```bash
# 1. 起 relay
cd D:\code\cgcon-v3
npm start

# 2. Chrome 加载 extension/（见上）

# 3. 打开 chatgpt.com，看 banner + popup

# 4. 断网测试：Chrome DevTools → Network → Offline
#    看 banner 变灰"离线"，恢复后自动 reload。

# 5. 恢复测试：
#    a) 发一个 review，看到"处理中"横幅时立即 F5
#    b) 刷新后 banner 显示"回捞中"，然后"已回捞"
#    c) Agent 侧收到 done reply
```