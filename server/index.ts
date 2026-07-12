// server/index.ts
// cgcon 主入口。Express + node:sqlite；启动 HTTP relay 服务。
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

const config = loadConfig();
const { app } = createApp(config);

app.listen(config.port, config.host, () => {
  console.log(
    `cgcon relay listening on http://${config.host}:${config.port}`,
  );
  console.log(`  data dir: ${config.dataDir}`);
  console.log(`  db file:  ${config.dbFile}`);
});