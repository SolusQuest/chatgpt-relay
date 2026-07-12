// server/index.ts
// Phase 0: 薄壳，加载 legacy server。Phase 1 起会替换为原生 v1 实现。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 默认端口 8766，避开与 v2 (8765) 冲突；env 覆盖
process.env.CGCON_PORT ??= '8766';

const require = createRequire(import.meta.url);
const legacyPath = path.resolve(__dirname, '..', 'legacy', 'server-old.js');

console.log(`[cgcon v3 shell] loading legacy server from ${legacyPath}`);
console.log(`[cgcon v3 shell] CGCON_PORT=${process.env.CGCON_PORT}`);
require(legacyPath);