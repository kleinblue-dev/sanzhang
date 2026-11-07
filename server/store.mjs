// store.mjs — JSONL 追加写 + 内存索引（零依赖，只用 node 内置模块）
//
// 存储模型：sessions.jsonl 是**事件流**，一行一个事件；进程内按 session_id 建索引。
// 读写纪律：
//   - 写只有一种方式：appendFile 追加一行；所有写走同一个 Promise 队列串行（不交错）。
//   - 启动时回放文件重建内存索引（文件是唯一真源，重启不丢数据）。
//   - finish 幂等：同一 id 第二次起直接返回，不再写盘（含并发：共享同一个 Promise）。
// 事件类型（字段与 ../shared/contract.md §3 对齐，不自造字段）：
//   { type:"create", session_id, condition:"A"|"B", started_at }
//   { type:"state",  session_id, phase:"pre"|"post", values:{q1,q2,q3,ux1?,ux2?} }
//   { type:"sheet",  session_id, round:1|2|3, metrics:{…§4} }
//   { type:"finish", session_id, finished_at, signature:{strokes:int}, steps:[{id:string,ms:int}] }

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = path.join(HERE, 'data');
export const STORE_FILE = path.join(DATA_DIR, 'sessions.jsonl');

/** @type {Map<string, any>} session_id -> 内存会话 */
const sessions = new Map();

/** 写队列尾：所有 appendFile 挂在它后面，保证串行 */
let chain = Promise.resolve();
let ready = false;

export function file() {
  return STORE_FILE;
}

function appendLine(ev) {
  const line = JSON.stringify(ev) + '\n';
  const p = chain.then(() => fsp.appendFile(STORE_FILE, line, 'utf8'));
  // 单次写失败不能毒死后续写入；失败由调用方处理
  chain = p.then(() => {}, () => {});
  return p;
}

function blank(id, condition, startedAt) {
  return {
    session_id: id,
    condition: condition === 'B' ? 'B' : 'A',
    started_at: startedAt,
    finished_at: null,
    duration_seconds: null,
    finished: false,
    state: { pre: null, post: null },
    sheets: { 1: null, 2: null, 3: null },
    signature_strokes: 0,
    steps: [],
    _finishing: null
  };
}

/** 把一条事件应用到内存索引（回放与在线写共用同一条路径） */
function apply(ev) {
  if (!ev || typeof ev !== 'object') return;
  const id = ev.session_id;
  if (typeof id !== 'string' || id === '') return;

  if (ev.type === 'create') {
    if (!sessions.has(id)) {
      sessions.set(id, blank(id, ev.condition, typeof ev.started_at === 'string' ? ev.started_at : new Date().toISOString()));
    }
    return;
  }

  const s = sessions.get(id);
  if (!s) return; // 没有 create 的事件行一律忽略，不猜状态

  if (ev.type === 'state') {
    if (ev.phase === 'pre' || ev.phase === 'post') s.state[ev.phase] = ev.values || null;
  } else if (ev.type === 'sheet') {
    const r = ev.round;
    if (r === 1 || r === 2 || r === 3) s.sheets[r] = ev.metrics || null;
  } else if (ev.type === 'finish') {
    s.finished = true;
    s.finished_at = typeof ev.finished_at === 'string' ? ev.finished_at : new Date().toISOString();
    s.signature_strokes = Number.isInteger(ev.signature && ev.signature.strokes) ? ev.signature.strokes : 0;
    s.steps = Array.isArray(ev.steps) ? ev.steps : [];
    const ms = Date.parse(s.finished_at) - Date.parse(s.started_at);
    s.duration_seconds = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : null;
  }
}

/** 对外会话视图：纯数据、无内部字段 */
function publicSession(s) {
  return {
    session_id: s.session_id,
    condition: s.condition,
    started_at: s.started_at,
    finished_at: s.finished_at,
    duration_seconds: s.duration_seconds,
    finished: s.finished,
    state: { pre: s.state.pre, post: s.state.post },
    sheets: { 1: s.sheets[1], 2: s.sheets[2], 3: s.sheets[3] },
    signature_strokes: s.signature_strokes,
    steps: s.steps
  };
}

/** 启动：建 data/ 目录，回放 JSONL 重建索引。返回已回放会话数。 */
export async function init() {
  if (ready) return sessions.size;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  let raw = '';
  try {
    raw = await fsp.readFile(STORE_FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      apply(JSON.parse(t));
    } catch {
      // 坏行跳过：一行坏数据不能阻止服务启动
    }
  }
  ready = true;
  return sessions.size;
}

/** 新建会话，返回 { session_id, condition } */
export async function create({ condition } = {}) {
  const id = crypto.randomUUID();
  const ev = {
    type: 'create',
    session_id: id,
    condition: condition === 'B' ? 'B' : 'A',
    started_at: new Date().toISOString()
  };
  apply(ev);
  try {
    await appendLine(ev);
  } catch (err) {
    sessions.delete(id); // 落盘失败就回滚内存，不让响应与存储不一致
    throw err;
  }
  return { session_id: id, condition: ev.condition };
}

/** 追加一次前测/后测；会话不存在返回 null */
export async function appendState(id, phase, values) {
  const s = sessions.get(id);
  if (!s) return null;
  const ev = { type: 'state', session_id: id, phase, values };
  apply(ev);
  await appendLine(ev);
  return publicSession(s);
}

/** 追加一张纸的过程指标；会话不存在返回 null */
export async function appendSheet(id, round, metrics) {
  const s = sessions.get(id);
  if (!s) return null;
  const ev = { type: 'sheet', session_id: id, round, metrics };
  apply(ev);
  await appendLine(ev);
  return publicSession(s);
}

/** 结束会话；幂等（含并发）。会话不存在返回 null */
export function finish(id, { signature, steps } = {}) {
  const s = sessions.get(id);
  if (!s) return Promise.resolve(null);
  if (s.finished) return Promise.resolve(publicSession(s));
  if (s._finishing) return s._finishing;

  const ev = {
    type: 'finish',
    session_id: id,
    finished_at: new Date().toISOString(),
    signature: { strokes: signature.strokes },
    steps
  };
  apply(ev);
  s._finishing = appendLine(ev)
    .catch((err) => {
      // 写盘失败回滚结束标记，允许调用方重试
      s.finished = false;
      s.finished_at = null;
      s.duration_seconds = null;
      throw err;
    })
    .finally(() => {
      s._finishing = null;
    })
    .then(() => publicSession(s));
  return s._finishing;
}

/** 调试读取；不存在返回 null */
export function get(id) {
  const s = sessions.get(id);
  return s ? publicSession(s) : null;
}

/** 全部会话（按创建顺序）；CSV 与调试用 */
export function list() {
  return [...sessions.values()].map(publicSession);
}

export function count() {
  return sessions.size;
}
