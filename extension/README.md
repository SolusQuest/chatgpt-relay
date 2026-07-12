# gpt-relay Extension (MV3)

Chrome/Edge/Brave 扩展。安装到浏览器后，负责在 chatgpt.com 页面里执行 relay
分发的 review 任务。

## 加载

1. 打开 `chrome://extensions/`
2. 右上角开启 **开发者模式 (Developer mode)**
3. 点 **加载已解压的扩展程序 (Load unpacked)**，选中 `extension/` 目录
4. 打开或刷新 chatgpt.com 标签页，页面顶部出现绿色 banner `Relay: xxxxxxxx…`
5. 工具栏点扩展图标查看 popup（health / sessions / recent tasks）

## 更新代码后

- `chrome://extensions/` → 找到 gpt-relay → 点 **刷新 (Reload)** 按钮
- 刷新 chatgpt.com 标签页（让 content-script 重新注入）

## 使用建议

- **每个 session 一个独立浏览器窗口**，任一窗口都不要最小化：Chrome 会冻结
  被最小化窗口里 tab 的 MutationObserver / setInterval / React scheduler，
  导致后台采样收不到新回复
- 窗口可以叠放、缩小、放副屏，只要不最小化即可
- 需要多个窗口完全遮盖仍工作时，Chrome 启动加
  `--disable-features=CalculateNativeWinOcclusion`

## Popup 功能

- 顶部状态灯：绿=relay 健康，红=不可达
- Sessions 表：当前每个 chatgpt tab 的 session、server 视角状态、in-flight taskId
- Recent tasks 表：最近 8 个 task 状态和耗时
- Relay URL：默认 `http://127.0.0.1:8765`，可改
- Poll now：立即触发一次 poll（跳过 alarm 间隔）
- Clear inflight：应急清空扩展本地 inflight + pending replies

## 权限说明

- `storage`：保存 relay URL / inflight 表 / pending replies / 最近错误
- `alarms`：driving 后台保活（chrome.alarms 最小周期 1 分钟）
- `tabs` / `scripting`：向 chatgpt.com tab 发消息
- `notifications`：预留（尚未使用）
- `host_permissions`：只覆盖 chatgpt.com 和本地 relay

## 架构

```
Agent → HTTP POST /v1/tasks → Server (Express + SQLite)
                                  ↑
                        HTTP long-poll
                                  ↓
                    Service Worker (extension)
                                  ↓ chrome.tabs.sendMessage
                    Content Script (chatgpt.com tab)
                                  ↓ DOM 操作
                          ChatGPT web app
```

- **Content script**：只做同步 DOM 操作：注入 prompt、点击 send、快照回复
- **Service Worker**：驱动一切
  - 定时通过 alarms + setTimeout 拉 `/internal/next_task` 长轮询任务
  - 认领后 `chrome.tabs.sendMessage(run-task)` 让 content script 提交
  - 提交后立即返回，SW 登记 `pending_replies` 状态机
  - 每 2 秒 sendMessage(poll-reply) 采样，连续 2 次相同文本 → POST `/complete`
- **恢复机制**：任何持久状态放在 `chrome.storage.local`
  （`inflight`、`pending_replies`、`tab_session_map`），SW 重启后自愈；
  reconcile 每 tick 对账 server 端 task 状态，孤儿 inflight 被清

## 恢复行为一览

| 场景 | 恢复者 | 方式 |
|---|---|---|
| Agent client 崩溃 | Server | task 状态保存在 SQLite；agent 重启后 `GET /v1/tasks/:id` 拉结果 |
| 页面 F5 | Content script | 从 sessionStorage 读 inflight；若 DOM 里已有回复 → `/recover`；生成中 → `reattach-pending` 交回 SW |
| SW 被 Chrome 休眠 | SW | 下次 alarm 唤醒时读 `pending_replies` map 继续采样 |
| 扩展 reload / 浏览器重启 | SW reconcile | 每 tick GET `/v1/tasks/:id` 检查孤儿 inflight，terminal 则清 |
| 断网 / VPN 切换 | Content script | `online`/`offline` 事件 + fetch hook，连续失败自动 reload |

## Sanity check

```bash
# 1. 起 relay
cd D:\code\cgcon-v3
npm start

# 2. Chrome 加载 extension/（见上）

# 3. 打开 chatgpt.com，看 banner + popup

# 4. 发一个 review（另一个 shell）
"帮我 review 这段代码：function add(a,b){return a+b}" | \
  gpt-relay review --session <id-from-popup> --stdin --timeout 60000

# 5. 恢复测试：
#    a) 发一个 review，看到"处理中"banner 时立即 F5
#    b) 刷新后 banner 显示"回捞中"，然后自动交回 SW 继续
#    c) Agent 侧收到 done reply
```
