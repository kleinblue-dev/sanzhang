// 墨引擎读数验收：真浏览器里驱动 ink.js，跑「仪器有效性」两极端（真鼠标事件）。
// 用法：node tests/metrics.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const PORT = Number(process.env.TEST_PORT || 8897);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, e); } };

const server = spawn(process.execPath, [path.join(APP, 'server', 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

const FIELDS = ['pieces_used', 'blank_ratio', 'center_bias', 'ink_mean', 'ink_sd', 'undo_count',
  'reposition_count', 'first_place_ms', 'active_ms', 'scale_mean', 'scale_range',
  'groups_used', 'group_switches', 'hue_used'];

let browser;
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/config')).ok) break; } catch {} await sleep(120); }
  browser = await launch({ url: BASE + '/', width: 375, height: 667, port: 9335 });
  await sleep(900);

  console.log('\n[1] 模块与素材');
  const meta = await browser.eval(`(async () => {
    const m = await import('./ink.js');
    const host = document.createElement('div');
    host.id = '__probe';
    host.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#fff;width:375px;height:263px';
    document.body.appendChild(host);
    const board = m.createBoard(host, { width: 800, height: 560, dpr: 1 });
    board.mount();
    window.__probe = { board, PIECES: m.PIECES };
    return { n: m.PIECES.length, groups: [...new Set(m.PIECES.map(p => p.group))].sort() };
  })()`);
  ok(meta.n === 19, 'PIECES = 19', String(meta.n));
  ok(meta.groups.length === 3, '三个分组', JSON.stringify(meta.groups));

  const getBox = () => browser.eval(`(() => { const c = document.querySelector('#__probe canvas');
    const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const clickAt = async (fx, fy) => {
    const b = await getBox();
    const x = Math.round(b.x + b.w * fx), y = Math.round(b.y + b.h * fy);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await browser.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
    await sleep(60);
  };

  console.log('\n[2] 空纸');
  const empty = await browser.eval(`(() => { const b = window.__probe.board; b.reset(1); b.render(); return b.stats(); })()`);
  ok(FIELDS.every((k) => empty[k] !== undefined), '14 字段齐全', FIELDS.filter(k => empty[k] === undefined).join(','));
  ok(typeof empty.hue_used === 'object' && empty.hue_used.length === 5, 'hue_used 长度 5', JSON.stringify(empty.hue_used));
  ok(empty.pieces_used === 0, '空纸 pieces_used=0', String(empty.pieces_used));
  ok(empty.blank_ratio > 0.95, '空纸留白 >0.95', String(empty.blank_ratio));

  console.log('\n[3] 铺张一纸（10 笔真点击）');
  await browser.eval(`(() => { const { board } = window.__probe; board.reset(2); board.render(); })()`);
  const pts = [[0.2, 0.3], [0.35, 0.32], [0.5, 0.3], [0.65, 0.36], [0.3, 0.5],
    [0.45, 0.52], [0.6, 0.5], [0.75, 0.46], [0.4, 0.7], [0.55, 0.68]];
  for (let i = 0; i < 10; i++) {
    await browser.eval(`(() => { const { board, PIECES } = window.__probe; board.selectPiece(PIECES[${i} % PIECES.length].id); })()`);
    await clickAt(pts[i][0], pts[i][1]);
  }
  const busy = await browser.eval(`(() => { const b = window.__probe.board; b.render(); return b.stats(); })()`);
  ok(busy.pieces_used >= 8, '铺张后笔数 ≥8', String(busy.pieces_used));
  ok(busy.blank_ratio < empty.blank_ratio - 0.02, '铺张后留白下降', `${empty.blank_ratio} -> ${busy.blank_ratio}`);

  console.log('\n[4] 撤销');
  const und = await browser.eval(`(() => { const b = window.__probe.board;
    const before = b.stats().pieces_used; const r = b.undo(); b.render();
    return { before, after: b.stats().pieces_used, ret: r }; })()`);
  ok(und.ret !== false, 'undo 有返回', JSON.stringify(und));
  ok(und.after <= und.before - 1, '撤销后 -1 笔', JSON.stringify(und));

  console.log('\n[5] 三张同构');
  const same = await browser.eval(`(() => { const b = window.__probe.board;
    b.reset(1); b.render(); const h1 = b.exportPng().slice(-2000);
    b.reset(2); b.render(); const h2 = b.exportPng().slice(-2000);
    return { eq: h1 === h2 }; })()`);
  ok(same.eq, '空纸三张同构（同种子同形状）');

  console.log('\n[6] 导出');
  const png = await browser.eval(`window.__probe.board.exportPng()`);
  ok(typeof png === 'string' && png.startsWith('data:image/png'), 'exportPng dataURL', String(png || '').slice(0, 22));
} catch (e) {
  fail++; console.error('\nFATAL', e.message);
} finally {
  if (browser) await browser.close();
  server.kill();
  await sleep(200);
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
