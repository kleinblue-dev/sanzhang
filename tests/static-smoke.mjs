// 静态托管（无后端）冒烟：验证降级路径能走完全程。
// 用法：node tests/static-smoke.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../web');
const PORT = 8891;
const SHOTS = path.join(HERE, '_shots_static');

let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, e); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

// 纯静态服务器：不实现任何 /api，模拟 GitHub Pages
const statics = spawn(process.execPath, ['-e', `
  const http=require('http'),fs=require('fs'),path=require('path');
  const root=${JSON.stringify(WEB)};
  const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
  http.createServer((req,res)=>{
    let p=decodeURIComponent(req.url.split('?')[0]); if(p==='/')p='/index.html';
    const f=path.join(root,p);
    if(!f.startsWith(root)){res.writeHead(403).end();return;}
    fs.readFile(f,(e,b)=>{ if(e){res.writeHead(404,{'Content-Type':'text/plain'}).end('404');return;}
      res.writeHead(200,{'Content-Type':mime[path.extname(f)]||'application/octet-stream'}).end(b); });
  }).listen(${PORT},'127.0.0.1');
`], { stdio: 'ignore', windowsHide: true });

let browser;
try {
  await sleep(600);
  browser = await launch({ url: `http://127.0.0.1:${PORT}/`, width: 375, height: 667, port: 9336 });
  await sleep(1200);
  const screen = () => browser.eval(`document.querySelector('#stage')?.dataset.screen || ''`);
  const waitFor = async (fn, t = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if (await fn()) return true; await sleep(100); } return false; };
  const waitScreen = (s, t) => waitFor(async () => (await screen()) === s, t);
  const shot = async (tag) => browser.shot(path.join(SHOTS, tag + '.png'));

  ok(await waitScreen('gate'), '无后端也能到 gate', await screen());
  await shot('01-gate');
  const offline = await browser.eval(`document.body.innerText.includes('离线') || document.body.innerText.includes('本地')`);
  console.log('  离线提示出现:', offline);
  await browser.click('[data-next]');

  ok(await waitScreen('pre'), '到 pre');
  for (const q of ['1', '2', '3']) {
    const has = await browser.eval(`!!document.querySelector('[data-q="${q}"]')`);
    if (has) await browser.click(`[data-q="${q}"] [data-v="4"]`);
  }
  await browser.click('[data-next]');

  let sheets = 0;
  while (sheets < 3) {
    const inSheet = await waitFor(async () => (await screen()) === 'sheet');
    if (!inSheet) break;
    sheets++;
    const piece = await browser.eval(`document.querySelector('#tray [data-piece]')?.dataset.piece || ''`);
    if (piece) await browser.click(`#tray [data-piece="${piece}"]`);
    const b = await browser.eval(`(() => { const r = document.querySelector('#paper').getBoundingClientRect();
      return { x: r.x + r.width * 0.45, y: r.y + r.height * 0.45 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await browser.send('Input.dispatchMouseEvent', { type, x: Math.round(b.x), y: Math.round(b.y), button: 'left', clickCount: 1 });
    }
    await sleep(250);
    await browser.click('[data-round-done]');
    await waitFor(async () => (await screen()) !== 'sheet' || true, 1500);
    await sleep(1600);
  }
  ok(sheets >= 1, '完成摆墨（静态降级）', String(sheets));
  await shot('02-sheet-done');

  ok(await waitScreen('signature', 8000), '到 signature', await screen());
  await browser.click('[data-next]');
  ok(await waitScreen('post'), '到 post');
  for (const q of ['1', '2', '3', 'ux1', 'ux2']) {
    const has = await browser.eval(`!!document.querySelector('[data-q="${q}"]')`);
    if (has) await browser.click(`[data-q="${q}"] [data-v="4"]`);
  }
  await browser.click('[data-next]');
  ok(await waitScreen('cards', 8000), '到 cards', await screen());
  await shot('03-cards');
  await browser.click('[data-next]');
  ok(await waitScreen('replay', 6000), '到 replay');
  await browser.click('[data-next]');
  ok(await waitScreen('done', 6000), '到 done', await screen());
  await shot('04-done');

  // 本地导出按钮可用（降级时导出走本地 CSV）
  const hasExport = await browser.eval(`!!document.querySelector('[data-export]')`);
  ok(hasExport, 'done 屏有导出');

  // 无未捕获异常
  const errs = browser.events.filter((e) => e.method === 'Runtime.exceptionThrown');
  ok(errs.length === 0, '无未捕获 JS 异常', JSON.stringify(errs.slice(0, 2)));
  const sw = await browser.eval(`document.documentElement.scrollWidth`);
  ok(sw === 375, '375 宽无横滚', String(sw));
} catch (e) {
  fail++; console.error('\nFATAL', e.message);
} finally {
  if (browser) await browser.close();
  statics.kill();
  await sleep(200);
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  console.log('截图：', SHOTS);
  process.exit(fail ? 1 : 0);
}
