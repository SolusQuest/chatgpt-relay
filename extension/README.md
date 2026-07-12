# cgcon Extension (MV3)

Chrome/Edge/Brave 扩展。替代旧版 Tampermonkey 脚本，负责在 chatgpt.com 页面里
执行 relay 分发的 review 任务。

## 加载

1. 打开 `chrome://extensions/`
2. 右上角开启 **开发者模式 (Developer mode)**
3. 点 **加载已解压的扩展程序 (Load unpacked)**，选中 `D:\code\cgcon-v3\extension`
4. 打开或刷新一个 chatgpt.com 标签页，页面顶部应出现绿色 banner `Relay: xxxxxxxx…`
5. 工具栏点扩展图标查看 popup（sessions / recent tasks / 状态灯）

## 更新代码后

- 到 `chrome://extensions/` 找到 cgcon Relay 卡片，点 **刷新 (Reload)** 按钮
- 刷新 chatgpt.com 标签页（让 content-script 重新注入）

## 配置

Popup 里可以修改 relay URL（默认 `http://127.0.0.1:8766`）。改完点 Save 即时生效。
其他机器上如果 relay 装在别的端口，只需要改这里，不用改代码。

## 权限说明

- `storage`：保存 relay URL / inflight taskId / 最近错误
- `alarms`：driving 后台 polling（不受 tab 前台/后台影响）
- `tabs` / `scripting`：向 chatgpt.com tab 发消息
- `notifications`：Phase 4 会用来在 session paused 时弹通知
- `host_permissions` 只覆盖 chatgpt.com 和本地 relay

## 与旧 Tampermonkey 的差异

| 场景 | Tampermonkey | 扩展 |
|-----|--------------|------|
| 后台 tab | 定时器被节流，容易停摆 | Service Worker 独立于 tab，`chrome.alarms` 不受节流 |
| 断网/VPN 恢复 | 需要手动刷新页面 | Phase 4 自动检测并 reload |
| 页面刷新后 in-flight task | 丢失 | Phase 4 自动回捞 |
| 多标签协调 | 冲突时先到先得 | SW 侧检测同 conversation 只允许一个 tab 认领 |
| 更新方式 | @require URL + 手动改版本号 | git pull + Reload 按钮 |

## 已知限制（Phase 3 版本）

- 后台 tab 的注入依赖 `execCommand("insertText")`，仍需 focus；Phase 4 会切到
  React 事件路径解决。
- 断网后不自动 reload chatgpt tab；Phase 4 加。
- 页面刷新后 in-flight task 会 fail；Phase 4 加恢复。
- 图标是占位纯色版；不影响功能。

## 手动 sanity check

```
# 1. 起 relay
cd D:\code\cgcon-v3
npm start

# 2. 装扩展（见上）

# 3. 从另一个终端发 review
$env:CGCON_URL='http://127.0.0.1:8766'
"请给下面这段函数写一个 code review comment: `nfunction f(x){return x*2}" |
    node skills\cgcon-review\scripts\review.mjs --session <session-id-from-popup> --stdin
```