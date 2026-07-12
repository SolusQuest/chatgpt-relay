// server/index.ts
// v3 主入口。Phase 1: 原生实现 + 旧 API shim；不再委托 legacy server。
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

const config = loadConfig();
const { app } = createApp(config);

app.listen(config.port, config.host, () => {
  console.log(
    `cgcon relay v3 listening on http://${config.host}:${config.port}`,
  );
  console.log(`  data dir: ${config.dataDir}`);
  console.log(`  db file:  ${config.dbFile}`);
});