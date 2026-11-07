// 全量验收：接口 → 墨引擎 → 端到端（A 臂三张 / B 臂一张）。
// 用法：node tests/run-all.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const runs = [
  { name: 'API 契约', script: 'tests/api.mjs', env: {} },
  { name: '墨引擎读数', script: 'tests/metrics.mjs', env: {} },
  { name: '端到端 A 臂（三张）', script: 'tests/e2e.mjs', env: { FORCE_CONDITION: 'A', EXPECT_SHEETS: '3' } },
  { name: '端到端 B 臂（一张）', script: 'tests/e2e.mjs', env: { FORCE_CONDITION: 'B', EXPECT_SHEETS: '1' } }
];

let failed = 0;
for (const r of runs) {
  console.log(`\n========== ${r.name} ==========`);
  const res = spawnSync(process.execPath, [path.join(APP, r.script)], {
    cwd: APP,
    env: { ...process.env, ...r.env },
    stdio: 'inherit'
  });
  if (res.status !== 0) { failed++; console.log(`✗ ${r.name} 失败（exit ${res.status}）`); }
  else console.log(`✓ ${r.name}`);
}

console.log(`\n========== 汇总：${runs.length - failed}/${runs.length} 套通过 ==========`);
process.exit(failed ? 1 : 0);
