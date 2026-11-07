// API 契约验收：起服务 → 打全接口 → 校验字段/幂等/CSV。
// 用法：node tests/api.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const PORT = Number(process.env.TEST_PORT || 8899);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/config'); if (r.ok) return; } catch {}
    await sleep(120);
  }
  throw new Error('server 未就绪');
}

const REQUIRED_COPY = [
  'gate_title', 'gate_promise1', 'gate_promise2', 'gate_promise3', 'gate_start',
  'pre_title', 'pre_q1', 'pre_q2', 'pre_q3', 'pre_next',
  'sheet_title', 'sheet_hint', 'sheet_done', 'sheet_undo', 'sheet_tray',
  'signature_title', 'signature_hint', 'signature_skip',
  'post_title', 'post_q1', 'post_q2', 'post_q3', 'post_ux1', 'post_ux2', 'post_next',
  'cards_change_title', 'cards_process_title', 'cards_hint',
  'replay_title', 'replay_hint',
  'done_title', 'done_export', 'done_again',
  'err_offline'
];
const MEDICAL = ['治疗', '治愈', '疗效', '疗程', '抑郁', '焦虑症', '诊断', '康复', '临床'];

const server = spawn(process.execPath, [path.join(APP, 'server', 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

try {
  await waitReady();

  console.log('\n[1] /api/config');
  const cfg = await (await fetch(BASE + '/api/config')).json();
  ok(cfg.version === '1', 'version=1', cfg.version);
  ok(cfg.copy && typeof cfg.copy === 'object', 'copy 是对象');
  const missing = REQUIRED_COPY.filter((k) => !(k in cfg.copy));
  ok(missing.length === 0, '契约文案键齐全', missing.join(','));
  const longs = Object.entries(cfg.copy).filter(([, v]) => typeof v === 'string' && v.length > 16);
  ok(longs.length === 0, '每条文案 ≤16 字', longs.map(([k, v]) => `${k}=${v}`).join(' | '));
  const med = Object.entries(cfg.copy).filter(([, v]) => MEDICAL.some((m) => String(v).includes(m)));
  ok(med.length === 0, '无医疗词', med.map(([k]) => k).join(','));

  console.log('\n[2] /api/scripts');
  const scr = await (await fetch(BASE + '/api/scripts')).json();
  ok(scr.lines && [1, 2, 3].every((r) => Array.isArray(scr.lines[r]) && scr.lines[r].length >= 3),
    '三轮各≥3条', JSON.stringify(Object.keys(scr.lines || {})));
  const bad = [];
  for (const r of [1, 2, 3]) for (const it of scr.lines[r] || []) {
    if (!it.pre || !it.post || it.pre.length > 16 || it.post.length > 16) bad.push(`${r}:${it.pre}/${it.post}`);
    if (/很好|很棒|说明你|意味着/.test(it.post || '')) bad.push(`评价性:${it.post}`);
  }
  ok(bad.length === 0, '脚本 ≤16 字且无评价', bad.join(' | '));

  console.log('\n[3] 会话全流程');
  // CSV 导出的是全部历史；用增量断言，跑前不必清库
  const csvOf = async () => (await (await fetch(BASE + '/api/export.csv')).text()).trim().split('\n').length;
  const rowsBefore = await csvOf();
  const mk = async () => (await (await fetch(BASE + '/api/session', { method: 'POST' })).json());
  const s1 = await mk(); const s2 = await mk();
  ok(/^[a-z0-9-]{8,}$/i.test(s1.session_id || ''), '返回 session_id', JSON.stringify(s1));
  ok(['A', 'B'].includes(s1.condition), 'condition ∈ {A,B}', s1.condition);

  const post = (u, b) => fetch(BASE + u, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b)
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  for (const s of [s1, s2]) {
    const id = s.session_id;
    const r1 = await post(`/api/session/${id}/state`, { phase: 'pre', values: { q1: 5, q2: 4, q3: 6 } });
    ok(r1.status === 200 && r1.body.ok, `state(pre) ${id.slice(0, 6)}`, JSON.stringify(r1));
    for (const r of [1, 2, 3]) {
      const rb = await post(`/api/session/${id}/sheet`, {
        round: r, metrics: {
          pieces_used: 4, blank_ratio: 0.9, center_bias: 0.2, ink_mean: 0.4, ink_sd: 0.1,
          hue_used: [3, 1, 0, 0, 0], undo_count: 0, reposition_count: 1, first_place_ms: 900,
          active_ms: 20000, scale_mean: 1, scale_range: 0, groups_used: 2, group_switches: 1, first_group: 0
        }
      });
      ok(rb.status === 200 && rb.body.ok, `sheet(${r}) ${id.slice(0, 6)}`);
    }
    const r2 = await post(`/api/session/${id}/state`, { phase: 'post', values: { q1: 3, q2: 3, q3: 4, ux1: 6, ux2: 5 } });
    ok(r2.status === 200, `state(post) ${id.slice(0, 6)}`);
    const rf = await post(`/api/session/${id}/finish`, { signature: { strokes: 1 }, steps: [{ id: 'gate', ms: 1200 }] });
    ok(rf.status === 200 && rf.body.ok, `finish ${id.slice(0, 6)}`, JSON.stringify(rf));
  }

  console.log('\n[4] 幂等');
  const before = (await (await fetch(BASE + '/api/export.csv')).text()).trim().split('\n').length;
  await post(`/api/session/${s1.session_id}/finish`, { signature: { strokes: 1 }, steps: [] });
  const after = (await (await fetch(BASE + '/api/export.csv')).text()).trim().split('\n').length;
  ok(before === after, '重复 finish 不新增行', `${before} -> ${after}`);

  console.log('\n[5] CSV');
  const csv = await (await fetch(BASE + '/api/export.csv')).text();
  const lines = csv.trim().split('\n');
  ok(lines.length === rowsBefore + 2, 'CSV 行数 = 基线+2', `${rowsBefore} -> ${lines.length}`);
  ok(/state_pre_q1/.test(lines[0]), 'CSV 含 state_pre_q1');
  ok(/sheet1_pieces_used/.test(lines[0]), 'CSV 含 sheet1_pieces_used');
  ok(/duration_seconds/.test(lines[0]), 'CSV 含 duration_seconds');

  console.log('\n[6] 静态与错误');
  const home = await fetch(BASE + '/');
  ok(home.ok && /<html/i.test(await home.text()), 'GET / 返回页面');
  const trav = await fetch(BASE + '/../server/server.mjs');
  ok(trav.status === 403 || trav.status === 404, '路径穿越被挡', String(trav.status));
  const badRoute = await fetch(BASE + '/api/nope');
  ok(badRoute.status === 404, '未知路由 404', String(badRoute.status));
  const badjson = await fetch(BASE + '/api/session', { method: 'POST', body: '{' });
  ok(badjson.status === 400 || badjson.status === 422, '坏 JSON 4xx', String(badjson.status));

  console.log('\n[7] 静态文件白名单');
  const js = await fetch(BASE + '/app.js');
  ok([200, 404].includes(js.status), 'app.js 可服务或不存在', String(js.status));
} catch (e) {
  fail++;
  console.error('\nFATAL', e.message);
} finally {
  server.kill();
  await sleep(200);
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
