// 端到端验收：真浏览器、真坐标点击、375×667。
// 用法：node tests/e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const SHOTS = path.join(HERE, '_shots');
const PORT = Number(process.env.TEST_PORT || 8898);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => {
  if (c) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const server = spawn(process.execPath, [path.join(APP, 'server', 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE + '/api/config')).ok) return; } catch {}
    await sleep(120);
  }
  throw new Error('server 未就绪');
}

let browser, shotN = 0;
const seq = [];

try {
  await waitReady();
  browser = await launch({ url: BASE + '/', width: 375, height: 667, port: 9334 });
  await sleep(900);

  const screen = () => browser.eval(`document.querySelector('#stage')?.dataset.screen || ''`);
  const round = () => browser.eval(`document.querySelector('#stage')?.dataset.round || ''`);
  const shot = async (tag) => browser.shot(path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${tag}.png`));
  const waitFor = async (fn, timeout = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (await fn()) return true; await sleep(90); }
    return false;
  };
  const waitScreen = (s, t) => waitFor(async () => (await screen()) === s, t);
  // 只数真正可见的字（innerText 会跳过 hidden/display:none）
  const textOf = async (sel = '#stage') => browser.eval(
    `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if(!el) return -1;
      const s = el.innerText || ''; return (s.match(/[\\u4e00-\\u9fa5]/g)||[]).length; })()`);
  const record = async () => { const s = await screen(); seq.push(s); return s; };

  console.log('\n[1] gate');
  ok(await waitScreen('gate'), '进入 gate', await screen());
  await shot('gate');
  await record();
  let n = await textOf();
  ok(n >= 0 && n <= 40, 'gate 中文 ≤40', String(n));
  await browser.click('[data-next]');

  console.log('\n[2] pre');
  ok(await waitScreen('pre'), '进入 pre', await screen());
  for (const q of ['1', '2', '3']) {
    const has = await browser.eval(`!!document.querySelector('[data-q="${q}"]')`);
    ok(has, `pre 题 ${q} 存在`);
    if (has) await browser.click(`[data-q="${q}"] [data-v="4"]`);
  }
  await shot('pre');
  n = await textOf();
  ok(n <= 40, 'pre 中文 ≤40', String(n));
  await record();
  await browser.click('[data-next]');

  console.log('\n[3] 摆墨（A 组三张 / B 组一张，服务端 1:1 随机）');
  let sheetsDone = 0;
  for (let r = 1; r <= 3; r++) {
    const inSheet = await waitFor(async () => (await screen()) === 'sheet', 8000);
    if (!inSheet) break;
    sheetsDone++;
    const curRound = await round();
    await shot(`sheet${sheetsDone}`);
    n = await textOf();
    ok(n > 0 && n <= 30, `第 ${sheetsDone} 张中文 ≤30`, String(n));

    // 取块 → 点纸（真鼠标）
    const piece = await browser.eval(`document.querySelector('#tray [data-piece]')?.dataset.piece || ''`);
    ok(!!piece, `第 ${sheetsDone} 张托盘有块`, piece);
    if (piece) await browser.click(`#tray [data-piece="${piece}"]`);
    const box = await browser.eval(`(() => { const r0 = document.querySelector('#paper').getBoundingClientRect();
      return { x: r0.x + r0.width * 0.45, y: r0.y + r0.height * 0.45 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await browser.send('Input.dispatchMouseEvent', {
        type, x: Math.round(box.x), y: Math.round(box.y), button: 'left', clickCount: 1
      });
    }
    await sleep(250);
    ok(await browser.eval(`!!document.querySelector('[data-undo]')`), `第 ${sheetsDone} 张有撤销`);
    ok(await browser.eval(`!!document.querySelector('[data-round-done]')`), `第 ${sheetsDone} 张有收笔`);

    await browser.click('[data-round-done]');
    // 幕布自动推进：只等，不再点任何按钮
    await waitFor(async () => (await screen()) !== 'sheet' || (await round()) !== String(curRound), 8000);
  }
  ok(sheetsDone >= 1, '至少完成 1 张', String(sheetsDone));
  const expect = Number(process.env.EXPECT_SHEETS || 0);
  if (expect) ok(sheetsDone === expect, `纸数 = （condition=）`, String(sheetsDone));

  console.log('\n[4] 落款');
  ok(await waitScreen('signature', 8000), '进入 signature', await screen());
  await shot('signature');
  await record();
  await browser.click('[data-next]');

  console.log('\n[5] 后测');
  ok(await waitScreen('post'), '进入 post', await screen());
  for (const q of ['1', '2', '3', 'ux1', 'ux2']) {
    const has = await browser.eval(`!!document.querySelector('[data-q="${q}"]')`);
    ok(has, `post 题 ${q} 存在`);
    if (has) await browser.click(`[data-q="${q}"] [data-v="4"]`);
  }
  await shot('post');
  n = await textOf();
  ok(n <= 50, 'post 中文 ≤50', String(n));
  await record();
  await browser.click('[data-next]');

  console.log('\n[6] 双卡（C1）');
  ok(await waitScreen('cards', 8000), '进入 cards', await screen());
  ok(await browser.eval(`!!document.querySelector('[data-card="change"]')`), '变化卡存在');
  ok(await browser.eval(`!!document.querySelector('[data-card="process"]')`), '过程卡存在');
  n = await textOf();
  ok(n <= 90, 'cards 中文 ≤90（不含英文指标名）', String(n));
  await shot('cards');
  await record();
  const iPost = seq.indexOf('post'), iCards = seq.indexOf('cards');
  ok(iPost >= 0 && iCards > iPost, 'C1 卡片在后测之后', `post@${iPost} cards@${iCards}`);

  console.log('\n[7] 回放与收卷');
  await browser.click('[data-next]');
  ok(await waitScreen('replay', 6000), '进入 replay', await screen());
  await shot('replay');
  await record();
  await browser.click('[data-next]');
  ok(await waitScreen('done', 6000), '进入 done', await screen());
  await shot('done');
  await record();

  console.log('\n[8] 布局');
  const sw = await browser.eval(`document.documentElement.scrollWidth`);
  ok(sw === 375, '375 宽无横向溢出', String(sw));
  const bodySw = await browser.eval(`document.body.scrollWidth`);
  ok(bodySw <= 375, 'body 不超宽', String(bodySw));

  console.log('\n[9] 数据回收');
  const csv = await (await fetch(BASE + '/api/export.csv')).text();
  ok(/state_pre_q1/.test(csv), 'CSV 含 state_pre_q1');
  ok(/sheet1_pieces_used/.test(csv), 'CSV 含 sheet1_pieces_used');
  ok(csv.trim().split('\n').length >= 2, '有会话入库', `rows=${csv.trim().split('\n').length}`);

  console.log('\n[10] 文案预算（来自 /api/config）');
  const cfg = await (await fetch(BASE + '/api/config')).json();
  const over = Object.entries(cfg.copy).filter(([, v]) => String(v).length > 16);
  ok(over.length === 0, '所有文案 ≤16 字', over.map(([k]) => k).join(','));
  const longTitles = ['gate_title', 'pre_title', 'sheet_title', 'post_title', 'cards_change_title', 'replay_title', 'done_title']
    .filter((k) => (cfg.copy[k] || '').length > 8);
  ok(longTitles.length === 0, '标题 ≤8 字', longTitles.join(','));

  console.log('\n屏幕序列：', seq.join(' → '));
} catch (e) {
  fail++;
  console.error('\nFATAL', e.message);
  if (browser) { try { await browser.shot(path.join(SHOTS, 'fatal.png')); } catch {} }
} finally {
  if (browser) await browser.close();
  server.kill();
  await sleep(200);
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  console.log('截图：', SHOTS);
  process.exit(fail ? 1 : 0);
}
