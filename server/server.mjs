// server.mjs — 「三张」零依赖 HTTP 服务（node:http，同源同时提供 /api/* 与 web/ 静态文件）
//
// 唯一真源：../shared/contract.md。本文件只实现 §3 的 8 条路由，不自造接口与字段。
// 启动：node server/server.mjs            → http://127.0.0.1:8787
// 环境：PORT（默认 8787）、HOST（默认 127.0.0.1）、WEB_ROOT（默认 ../web，仅自验用）
// 依赖：无。不读 package.json，不装任何 npm 包。

import http from 'node:http';
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as store from './store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const DATA_DIR = path.join(HERE, 'data');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const WEB_ROOT = path.resolve(process.env.WEB_ROOT || path.join(APP, 'web'));
const MAX_BODY = 256 * 1024; // 契约任务：body 上限 256KB

/** 静态白名单后缀 → MIME（contract §3 静态资源） */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};
const STATIC_EXT = new Set(Object.keys(MIME));

/** 过程指标字段（contract §4，顺序即 CSV 列顺序） */
const METRIC_KEYS = [
  'pieces_used', 'blank_ratio', 'center_bias', 'ink_mean', 'ink_sd', 'hue_used',
  'undo_count', 'reposition_count', 'first_place_ms', 'active_ms',
  'scale_mean', 'scale_range', 'groups_used', 'group_switches', 'first_group'
];
const METRIC_NUM = new Set([
  'blank_ratio', 'center_bias', 'ink_mean', 'ink_sd', 'scale_mean', 'scale_range'
]);

/** CSV 列：会话族 + 状态族 + 过程族（字段名全部来自契约 §3/§4，不自造） */
const CSV_COLUMNS = [
  'session_id', 'condition', 'started_at', 'finished_at', 'duration_seconds',
  'state_pre_q1', 'state_pre_q2', 'state_pre_q3', 'state_pre_sum',
  'state_post_q1', 'state_post_q2', 'state_post_q3', 'state_post_sum',
  'state_delta_q1', 'state_delta_q2', 'state_delta_q3', 'state_delta_sum',
  'post_ux1', 'post_ux2',
  'signature_strokes', 'steps_json',
  ...[1, 2, 3].flatMap((r) => METRIC_KEYS.map((k) => `sheet${r}_${k}`))
];

// ---------------------------------------------------------------- 错误与响应

class HttpError extends Error {
  constructor(status, code) {
    super(code || String(status));
    this.status = status;
    this.code = code || 'error';
  }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Cache-Control', 'no-store');
}

function json(res, status, body) {
  cors(res);
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length
  });
  res.end(buf);
}

function err(res, status, code) {
  json(res, status, { error: code });
}

function need(cond, code) {
  if (!cond) throw new HttpError(400, code || 'bad_request');
}

// ---------------------------------------------------------------- 请求体

/** 读 body；超过 256KB 抛 413。返回 Buffer。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return; // 已判定超限：丢弃剩余数据，避免内存增长
      size += chunk.length;
      if (size > MAX_BODY) {
        settled = true;
        reject(new HttpError(413, 'too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
  });
}

/** 读 JSON body；空 body 视为 {}；解析失败 400。只接受对象。 */
async function readJson(req) {
  const buf = await readBody(req);
  const text = buf.toString('utf8').trim();
  if (!text) return {};
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json');
  }
  need(data !== null && typeof data === 'object' && !Array.isArray(data), 'bad_json');
  return data;
}

// ---------------------------------------------------------------- 数据文件（改 config.json 即生效）

const dataCache = new Map(); // absPath -> { mtimeMs, data }

async function loadData(name) {
  const abs = path.join(DATA_DIR, name);
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    throw new HttpError(500, 'data_missing');
  }
  const hit = dataCache.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.data;
  let data;
  try {
    data = JSON.parse(await fsp.readFile(abs, 'utf8'));
  } catch {
    throw new HttpError(500, 'data_invalid');
  }
  dataCache.set(abs, { mtimeMs: st.mtimeMs, data });
  return data;
}

// ---------------------------------------------------------------- 校验

const isInt = (v) => Number.isInteger(v);
const in1to7 = (v) => isInt(v) && v >= 1 && v <= 7;

function cleanStateValues(phase, values) {
  need(values && typeof values === 'object' && !Array.isArray(values), 'bad_values');
  for (const k of ['q1', 'q2', 'q3']) need(in1to7(values[k]), 'bad_values');
  const out = { q1: values.q1, q2: values.q2, q3: values.q3 };
  for (const k of ['ux1', 'ux2']) {
    if (values[k] === undefined) continue;
    need(in1to7(values[k]), 'bad_values');
    if (phase === 'post') out[k] = values[k];
  }
  return out;
}

function cleanMetrics(metrics) {
  need(metrics && typeof metrics === 'object' && !Array.isArray(metrics), 'bad_metrics');
  const out = {};
  for (const k of METRIC_KEYS) {
    const v = metrics[k];
    if (v === undefined) continue; // 允许字段缺省（如首张未产生某读数）
    if (k === 'hue_used') {
      need(Array.isArray(v) && v.length === 5 && v.every((n) => isInt(n) && n >= 0), 'bad_metrics');
    } else if (k === 'first_group') {
      need(v === null || (isInt(v) && v >= 0 && v <= 2), 'bad_metrics');
    } else if (METRIC_NUM.has(k)) {
      need(typeof v === 'number' && Number.isFinite(v), 'bad_metrics');
    } else {
      need(isInt(v) && v >= 0, 'bad_metrics');
    }
    out[k] = v;
  }
  return out;
}

function cleanFinish(body) {
  const sig = body.signature;
  need(sig && typeof sig === 'object' && !Array.isArray(sig), 'bad_signature');
  need(isInt(sig.strokes) && sig.strokes >= 0, 'bad_signature');
  need(Array.isArray(body.steps), 'bad_steps');
  const steps = body.steps.map((s) => {
    need(s && typeof s === 'object' && typeof s.id === 'string' && s.id.length > 0, 'bad_steps');
    need(typeof s.ms === 'number' && Number.isFinite(s.ms) && s.ms >= 0, 'bad_steps');
    return { id: s.id.slice(0, 64), ms: Math.round(s.ms) };
  });
  return { signature: { strokes: sig.strokes }, steps };
}

// ---------------------------------------------------------------- CSV

function sum3(o) {
  if (!o || !['q1', 'q2', 'q3'].every((k) => Number.isFinite(o[k]))) return null;
  return o.q1 + o.q2 + o.q3;
}

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function csvValues(s) {
  const pre = s.state.pre || null;
  const post = s.state.post || null;
  const preSum = sum3(pre);
  const postSum = sum3(post);
  const pick = (o, k) => (o && Number.isFinite(o[k]) ? o[k] : null);
  const delta = (k) => (pre && post && Number.isFinite(pre[k]) && Number.isFinite(post[k]) ? post[k] - pre[k] : null);

  const row = [
    s.session_id, s.condition, s.started_at, s.finished_at, s.duration_seconds,
    pick(pre, 'q1'), pick(pre, 'q2'), pick(pre, 'q3'), preSum,
    pick(post, 'q1'), pick(post, 'q2'), pick(post, 'q3'), postSum,
    delta('q1'), delta('q2'), delta('q3'),
    preSum !== null && postSum !== null ? postSum - preSum : null,
    pick(post, 'ux1'), pick(post, 'ux2'),
    s.signature_strokes, JSON.stringify(s.steps)
  ];

  for (const r of [1, 2, 3]) {
    const m = s.sheets[r] || null;
    for (const k of METRIC_KEYS) {
      const v = m ? m[k] : null;
      row.push(Array.isArray(v) ? v.join(';') : v); // hue_used 用分号连接
    }
  }
  return row;
}

// ---------------------------------------------------------------- 路由处理

async function getConfig(res) {
  const cfg = await loadData('config.json');
  if (!cfg || cfg.version !== '1' || !cfg.copy || !cfg.limits) throw new HttpError(500, 'data_invalid');
  json(res, 200, cfg);
}

async function getScripts(res) {
  const scr = await loadData('scripts.json');
  const lines = scr && scr.lines;
  const okShape = lines && typeof lines === 'object' && [1, 2, 3].every((r) => Array.isArray(lines[r]) && lines[r].length >= 3);
  if (!okShape) throw new HttpError(500, 'data_invalid');
  json(res, 200, scr);
}

async function postSession(req, res) {
  await readJson(req); // 契约 body 为 {}；仍要校验 JSON，坏 JSON 必须 400
  const forced = String(process.env.FORCE_CONDITION || '').toUpperCase();
  // 测试用固定臂：FORCE_CONDITION=A|B；不设则 1:1 随机
  const condition = (forced === 'A' || forced === 'B')
    ? forced
    : (crypto.randomInt(2) === 0 ? 'A' : 'B');
  const session = await store.create({ condition });
  json(res, 200, session);
}

async function getSession(res, id) {
  const session = store.get(id);
  if (!session) throw new HttpError(404, 'not_found');
  json(res, 200, { session });
}

async function postState(req, res, id) {
  const body = await readJson(req);
  need(body.phase === 'pre' || body.phase === 'post', 'bad_phase');
  const values = cleanStateValues(body.phase, body.values);
  const session = await store.appendState(id, body.phase, values);
  if (!session) throw new HttpError(404, 'not_found');
  json(res, 200, { ok: true });
}

async function postSheet(req, res, id) {
  const body = await readJson(req);
  need(isInt(body.round) && body.round >= 1 && body.round <= 3, 'bad_round');
  const metrics = cleanMetrics(body.metrics);
  const session = await store.appendSheet(id, body.round, metrics);
  if (!session) throw new HttpError(404, 'not_found');
  json(res, 200, { ok: true });
}

async function postFinish(req, res, id) {
  const body = await readJson(req);
  const existing = store.get(id);
  if (!existing) throw new HttpError(404, 'not_found');
  // 幂等：已结束的会话不再校验 body、不再写盘
  if (existing.finished) {
    json(res, 200, { ok: true, csv_url: '/api/export.csv' });
    return;
  }
  const payload = cleanFinish(body);
  await store.finish(id, payload);
  json(res, 200, { ok: true, csv_url: '/api/export.csv' });
}

async function getCsv(res) {
  const rows = store.list().map(csvValues);
  const lines = [CSV_COLUMNS.join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  // BOM + CRLF：Windows Excel 直接双击打开不乱码；fetch().text() 会剥掉 BOM，不影响断言
  const body = '\uFEFF' + lines.join('\r\n') + '\r\n';
  cors(res);
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="ink-fusion-sessions.csv"',
    'Content-Length': Buffer.byteLength(body, 'utf8')
  });
  res.end(body);
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'bad_path');
  }
  rel = rel.replaceAll('\\', '/'); // Windows 下 \ 也是分隔符，先归一再判穿越
  if (rel.includes('\0') || rel.split('/').includes('..')) throw new HttpError(403, 'forbidden');
  if (rel === '/' || rel === '') rel = '/index.html';
  const ext = path.extname(rel).toLowerCase();
  if (!STATIC_EXT.has(ext)) throw new HttpError(404, 'not_found');
  const abs = path.resolve(WEB_ROOT, '.' + (rel.startsWith('/') ? rel : '/' + rel));
  if (abs !== WEB_ROOT && !abs.startsWith(WEB_ROOT + path.sep)) throw new HttpError(403, 'forbidden');
  let buf;
  try {
    buf = await fsp.readFile(abs);
  } catch (e) {
    throw new HttpError(e.code === 'ENOENT' || e.code === 'EISDIR' ? 404 : 403, 'not_found');
  }
  cors(res);
  res.writeHead(200, {
    'Content-Type': MIME[ext],
    'Content-Length': buf.length
  });
  res.end(buf);
}

// ---------------------------------------------------------------- 分发

async function handle(req, res) {
  cors(res);
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  const method = (req.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ---- API（contract §3，只有这 8 条）
  if (p === '/api/config') {
    if (method === 'GET') return getConfig(res);
    throw new HttpError(405, 'method_not_allowed');
  }
  if (p === '/api/scripts') {
    if (method === 'GET') return getScripts(res);
    throw new HttpError(405, 'method_not_allowed');
  }
  if (p === '/api/export.csv') {
    if (method === 'GET') return getCsv(res);
    throw new HttpError(405, 'method_not_allowed');
  }
  if (p === '/api/session') {
    if (method === 'POST') return postSession(req, res);
    throw new HttpError(405, 'method_not_allowed');
  }
  const m = p.match(/^\/api\/session\/([^/]+)(?:\/(state|sheet|finish))?$/);
  if (m) {
    const id = safeId(m[1]);
    const sub = m[2] || '';
    if (!sub && method === 'GET') return getSession(res, id);
    if (sub === 'state' && method === 'POST') return postState(req, res, id);
    if (sub === 'sheet' && method === 'POST') return postSheet(req, res, id);
    if (sub === 'finish' && method === 'POST') return postFinish(req, res, id);
    throw new HttpError(405, 'method_not_allowed');
  }
  if (p.startsWith('/api/')) throw new HttpError(404, 'not_found');

  // ---- 静态（contract §3 静态资源）
  if (method === 'GET' || method === 'HEAD') return serveStatic(req, res, p);
  throw new HttpError(405, 'method_not_allowed');
}

function safeId(raw) {
  let id;
  try {
    id = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'bad_id');
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError(400, 'bad_id');
  return id;
}

// ---------------------------------------------------------------- 启动

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    try {
      if (!req.complete) req.resume(); // 未读完的 body 排空，避免 keep-alive 串包
    } catch {}
    if (res.headersSent) {
      try {
        res.destroy();
      } catch {}
      return;
    }
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error('[ink-fusion] 500', req.method, req.url, e);
    err(res, status, e instanceof HttpError ? e.code : 'internal');
  });
});

async function main() {
  const replayed = await store.init();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
  console.log(`[ink-fusion] http://${HOST}:${PORT}  web=${WEB_ROOT}  store=${store.file()}  sessions=${replayed}`);
}

function shutdown(sig) {
  console.log(`[ink-fusion] ${sig} 关闭`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((e) => {
  console.error('[ink-fusion] 启动失败:', e);
  process.exit(1);
});
