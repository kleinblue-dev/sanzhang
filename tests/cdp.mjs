// 极简 Chrome DevTools Protocol 客户端（零依赖，Node 24 内置 WebSocket）。
// 只用到的能力：导航、执行表达式、真鼠标事件、截图、375 视口模拟。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);

export function findChrome() {
  for (const c of CHROME_CANDIDATES) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(120);
  }
  throw new Error('chrome endpoint not ready: ' + url);
}

export async function launch({ url, width = 375, height = 667, port = 9333 } = {}) {
  const chrome = findChrome();
  if (!chrome) throw new Error('未找到 Chrome/Edge（可设 CHROME_PATH）');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inkfusion-cdp-'));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--disable-extensions', '--hide-scrollbars',
    `--window-size=${width},${height}`,
    'about:blank'
  ];
  const proc = spawn(chrome, args, { stdio: 'ignore', windowsHide: true });

  // 等 devtools 起来，拿一个 page target
  const list = await getJSON(`http://127.0.0.1:${port}/json/list`);
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('没有 page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };

  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const api = {
    send,
    events,
    async init() {
      await send('Page.enable');
      await send('Runtime.enable');
      await send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 2, mobile: true
      });
    },
    async goto(u) {
      await send('Page.navigate', { url: u });
      await sleep(600);
    },
    async eval(expression) {
      const r = await send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expression);
      return r.result.value;
    },
    /** 按真实坐标点击元素中心（不调内部函数） */
    async click(selector) {
      const box = await api.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({block:'center'});
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
      })()`);
      if (!box) throw new Error('元素不存在: ' + selector);
      if (box.w === 0 || box.h === 0) throw new Error('元素不可见(0 尺寸): ' + selector);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', {
          type, x: Math.round(box.x), y: Math.round(box.y),
          button: 'left', clickCount: 1
        });
      }
      await sleep(120);
      return box;
    },
    async shot(file) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
    async close() {
      try { ws.close(); } catch {}
      try { proc.kill(); } catch {}
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    }
  };

  await api.init();
  if (url) await api.goto(url);
  return api;
}
