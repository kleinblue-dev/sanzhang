/* 三张 · 外壳（shell）—— app/shared/contract.md 是唯一真源
 *
 * 本文件只做四件事：
 *   1) 8 屏状态机（gate → pre → sheet×3 → signature → post → cards → replay → done）
 *   2) 文案注入：界面文字全部来自 GET /api/config；本文件只保留一份兜底（FALLBACK_COPY，
 *      必须与 server/data/config.json 的 copy 同值）；除 aria-label 外不写任何可见文案。
 *   3) 外壳 DOM：#stage[data-screen]、#paper 挂载点、#tray 托盘（契约 §6）
 *   4) 提交与降级：pre/post/sheet/finish 打契约 §3 接口，失败按 §7 走 localStorage + 本地 CSV
 *
 * 水墨画布与 §4 过程指标全部由 web/ink.js 提供（契约 §5）；本文件不实现画布。
 * 契约缺口（已上报 Lead）：§3 copy 键集没有「过程卡指标名」与「墨色/大小/转」控件名，
 * 故指标名直接显示 §4 字段名（R4 的字段名唯一真源）、控件用符号 + aria-label，避免自造文案。
 */

/* ============================ 0. 兜底文案（唯一一份） ============================ */
/* 34 键 = 契约 §3 的 copy 键集；值须与 server/data/config.json 完全同值（backend 已确认）。 */
const FALLBACK_COPY = Object.freeze({
  gate_title: '三张纸',
  gate_promise1: '只摆不画',
  gate_promise2: '十二分钟',
  gate_promise3: '不做评判',
  gate_start: '开始',

  pre_title: '坐下之前',
  pre_q1: '身体紧不紧',
  pre_q2: '心里累不累',
  pre_q3: '念头乱不乱',
  pre_next: '继续',

  sheet_title: '摆一张',
  sheet_hint: '挑一块，摆上去',
  sheet_done: '收笔',
  sheet_undo: '撤销',
  sheet_tray: '取块',

  signature_title: '落款',
  signature_hint: '留一笔，或跳过',
  signature_skip: '跳过',

  post_title: '再看一次',
  post_q1: '身体紧不紧',
  post_q2: '心里累不累',
  post_q3: '念头乱不乱',
  post_ux1: '刚才顺手吗',
  post_ux2: '愿意再来',
  post_next: '看看',

  cards_change_title: '前后变化',
  cards_process_title: '三张过程',
  cards_hint: '点开看全部',

  replay_title: '三张',
  replay_hint: '横滑回看',

  done_title: '收卷',
  done_export: '导出',
  done_again: '重来',

  err_offline: '离线，结果存本机',
});

/* ============================ 1. 常量 / 状态 ============================ */
const API_BASE = (() => {
  const meta = document.querySelector('meta[name="api-base"]');
  const raw = (window.__API_BASE__ || (meta && meta.content) || '').trim();
  return raw.replace(/\/+$/, '');
})(); // R1：默认同源；分域部署只改 index.html 的 meta，不动本文件
const ROUND_TOTAL = 3;
const FALLBACK_LIMIT = 7;

/** 契约 §4 过程指标（字段名只此一份，R4） */
const METRIC_KEYS = [
  'pieces_used', 'blank_ratio', 'center_bias', 'ink_mean', 'ink_sd',
  'hue_used', 'undo_count', 'reposition_count', 'first_place_ms', 'active_ms',
  'scale_mean', 'scale_range', 'groups_used', 'group_switches', 'first_group',
];
/** 过程卡主读 6 项，其余折叠（层现原则：先 3 条主读数，点开才展开全部） */
const METRIC_MAIN = ['pieces_used', 'blank_ratio', 'center_bias', 'ink_mean', 'scale_mean', 'active_ms'];
const METRIC_REST = METRIC_KEYS.filter((k) => !METRIC_MAIN.includes(k));

const COPY_KEYS = Object.keys(FALLBACK_COPY);

const state = {
  screen: '',
  stepId: '',
  stepAt: 0,
  steps: [],
  copy: { ...FALLBACK_COPY },
  limits: { pre: FALLBACK_LIMIT, post: FALLBACK_LIMIT },
  lines: null,
  session: '',
  condition: 'A',
  remoteSession: false,
  startedAt: Date.now(),
  finishedAt: 0,
  pre: null,
  post: null,
  sheets: [], // [{ round, metrics, png }]
  sigStrokes: 0,
  round: 0,
  csvUrl: '',
  localExport: false,
  pending: [], // 提交失败队列
  offline: false,
};

const RM = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
if (RM) document.documentElement.classList.add('rm');

const stage = document.getElementById('stage');
const netbar = document.getElementById('netbar');

const S = { sections: [] }; // 各屏 DOM 引用
let board = null; // ink.js 实例
let PIECES = []; // ink.js PIECES
let busy = false; // 屏内互斥（收笔/翻页）

/* ============================ 2. DOM 小工具 ============================ */
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'hidden') node.hidden = !!v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(3)) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

const t = (key) => {
  const v = state.copy[key];
  return typeof v === 'string' && v ? v : FALLBACK_COPY[key] || '';
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const numOrNull = (v) => (Number.isFinite(+v) ? +v : null);

function hash(str) {
  let h = 2166136261 >>> 0;
  for (const ch of String(str)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function section(id, cls = 'screen') {
  const sec = el('section', { class: `${cls} screen-${id}`, id: `s-${id}` });
  S.sections.push(sec);
  return sec;
}

function nextButton(copyKey, onClick) {
  const btn = el('button', { type: 'button', class: 'btn primary', 'data-next': '', text: t(copyKey) });
  btn.dataset.copy = copyKey;
  btn.addEventListener('click', onClick);
  return btn;
}

/* ============================ 3. HTTP（同源，超时即失败） ============================ */
async function api(path, { method = 'GET', body = null, timeout = 6000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(API_BASE + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? await res.json() : await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ============================ 4. 启动 ============================ */
async function boot() {
  applyCopy(); // 先用兜底文案建骨架，/api/config 回来再覆盖
  build();

  const [cfgR, scriptsR, sessR] = await Promise.allSettled([
    api('/api/config', { timeout: 4000 }),
    api('/api/scripts', { timeout: 4000 }),
    api('/api/session', { method: 'POST', body: {}, timeout: 4000 }),
  ]);

  // 4.1 文案：/api/config 失败 → 唯一兜底 + 顶部一行 err_offline（§7）
  const cfg = cfgR.status === 'fulfilled' ? cfgR.value : null;
  if (cfg && cfg.copy) {
    state.copy = { ...FALLBACK_COPY, ...pickCopy(cfg.copy) };
    state.limits = { pre: maxOf(cfg.limits, 'pre'), post: maxOf(cfg.limits, 'post') };
  } else {
    console.warn('[shell] GET /api/config 失败，改用内置兜底文案', cfgR.reason);
    state.copy = { ...FALLBACK_COPY };
    state.offline = true;
  }

  // 4.2 引导/承接（可选；缺失时退回 copy.sheet_hint）
  const scripts = scriptsR.status === 'fulfilled' ? scriptsR.value : null;
  state.lines = scripts && scripts.lines ? scripts.lines : null;

  // 4.3 会话：失败 → 本地 id + condition A + localStorage（§7）
  const sess = sessR.status === 'fulfilled' ? sessR.value : null;
  if (sess && sess.session_id) {
    state.session = String(sess.session_id);
    state.condition = sess.condition === 'B' ? 'B' : 'A';
    state.remoteSession = true;
  } else {
    console.warn('[shell] POST /api/session 失败，进入本地降级', sessR.reason);
    state.session = `L-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    state.condition = 'A';
    state.remoteSession = false;
    state.localExport = true;
  }

  applyCopy(); // 文案二次注入（含 title / aria-label）
  buildQuizOptions();
  if (state.offline) showOffline();

  persist();
  state.stepAt = Date.now();
  go('gate');
  document.body.classList.remove('booting');
}

/* ============================ 5. 文案注入 ============================ */
function pickCopy(raw) {
  const out = {};
  for (const k of COPY_KEYS) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

/** limits 契约写法 `{pre:1..7}`，但实际后端可能是 7 / [1,7] / {min,max}，全部防御解析 */
function maxOf(limits, kind) {
  const v = limits ? limits[kind] : undefined;
  if (typeof v === 'number') return clamp(Math.round(v) || FALLBACK_LIMIT, 2, 10);
  if (Array.isArray(v)) return clamp(Math.round(+v[1]) || FALLBACK_LIMIT, 2, 10);
  if (v && typeof v === 'object' && Number.isFinite(+v.max)) return clamp(Math.round(+v.max), 2, 10);
  return FALLBACK_LIMIT;
}

function applyCopy() {
  document.title = t('gate_title');
  document.querySelectorAll('[data-copy]').forEach((node) => {
    const key = node.dataset.copy;
    const val = t(key);
    if (node.tagName === 'INPUT') node.setAttribute('aria-label', val);
    else node.textContent = val;
  });
}

function showOffline() {
  netbar.textContent = t('err_offline');
  netbar.hidden = false;
  document.body.classList.add('offline');
}

/* ============================ 6. 建屏 ============================ */
function build() {
  buildGate();
  buildQuiz('pre');
  buildInk();
  buildQuiz('post');
  buildCards();
  buildReplay();
  buildDone();
  applyCopy();
}

/* --- 6.1 gate ------------------------------------------------------------- */
function buildGate() {
  const sec = section('gate');
  const startBtn = nextButton('gate_start', () => {
    if (busy) return;
    go('pre');
  });
  S.gateStart = startBtn;

  const promiseNodes = ['gate_promise1', 'gate_promise2', 'gate_promise3'].map((key) =>
    el('li', {}, el('i', { class: 'pmark', 'aria-hidden': 'true' }), el('span', { 'data-copy': key })));

  sec.append(
    el('div', { class: 'gate-top' },
      el('div', { class: 'gate-mark', 'aria-hidden': 'true' }),
      el('div', { class: 'gate-strokes', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')),
      el('h1', { class: 'h1 gate-title', 'data-copy': 'gate_title' }),
    ),
    el('ul', { class: 'promises' }, promiseNodes),
    el('div', { class: 'gate-foot' }, startBtn),
  );
  stage.append(sec);
}

/* --- 6.2 pre / post（1–7 圆点，点选即答） --------------------------------- */
function buildQuiz(kind) {
  const isPre = kind === 'pre';
  const specs = isPre
    ? [['1', 'pre_q1'], ['2', 'pre_q2'], ['3', 'pre_q3']]
    : [['1', 'post_q1'], ['2', 'post_q2'], ['3', 'post_q3'], ['ux1', 'post_ux1'], ['ux2', 'post_ux2']];

  const sec = section(kind);
  const list = el('div', { class: 'qlist' });
  const groups = [];

  for (const [q, key] of specs) {
    const dots = el('div', { class: 'dots', role: 'radiogroup', 'data-q': q });
    dots.setAttribute('aria-label', t(key));
    dots.dataset.labelKey = key;
    groups.push(dots);
    const qRow = el('div', { class: 'q' }, el('span', { class: 'qlabel', 'data-copy': key }), dots);
    list.append(qRow);
  }

  const nextBtn = nextButton(isPre ? 'pre_next' : 'post_next', () => (isPre ? onPreNext() : onPostNext()));
  nextBtn.disabled = true;

  sec.append(
    el('header', { class: 'quizhead' }, el('h2', { class: 'h2', 'data-copy': isPre ? 'pre_title' : 'post_title' })),
    list,
    el('div', { class: 'grow' }),
    el('div', { class: 'quiz-foot' }, nextBtn),
  );
  stage.append(sec);
  S[kind] = { sec, groups, next: nextBtn };
}

/** 圆点按钮在配置回来后按 limits 生成（默认 1–7） */
function buildQuizOptions() {
  for (const kind of ['pre', 'post']) {
    const refs = S[kind];
    const max = state.limits[kind] || FALLBACK_LIMIT;
    for (const dots of refs.groups) {
      dots.textContent = '';
      delete dots.dataset.value;
      for (let v = 1; v <= max; v += 1) {
        const btn = el('button', { type: 'button', class: 'dot', 'data-v': String(v) });
        btn.style.setProperty('--i', String(v - 1));
        btn.setAttribute('aria-label', String(v));
        btn.addEventListener('click', () => setAnswer(kind, dots, v));
        dots.append(btn);
      }
    }
    refs.next.disabled = true;
  }
}

function setAnswer(kind, dots, v) {
  dots.dataset.value = String(v);
  dots.querySelectorAll('.dot').forEach((btn) => {
    btn.classList.toggle('on', Number(btn.dataset.v) === v);
  });
  dots.setAttribute('aria-label', `${t(dots.dataset.labelKey)} ${v}`);
  updateNext(kind);
}

function updateNext(kind) {
  const refs = S[kind];
  const coreOk = ['1', '2', '3'].every((q) => {
    const dots = refs.groups.find((g) => g.dataset.q === q);
    return dots && dots.dataset.value;
  });
  refs.next.disabled = !coreOk;
}

/** 读答：pre 三题必答；post 三题必答、体验题可缺（契约 §3）
 *  注意：DOM 上的 data-q 是 "1|2|3|ux1|ux2"（Lead 的 e2e 选择器），
 *  而接口字段是 q1|q2|q3|ux1|ux2（契约 §3），这里做一次映射。 */
function readAnswers(kind) {
  const refs = S[kind];
  const out = {};
  for (const dots of refs.groups) {
    const q = dots.dataset.q;
    const isUx = q === 'ux1' || q === 'ux2';
    const v = dots.dataset.value ? Number(dots.dataset.value) : null;
    if (isUx) {
      if (v != null) out[q] = v;
      continue;
    }
    if (v == null) return null;
    out[`q${q}`] = v;
  }
  return out;
}

/* --- 6.3 ink：sheet ×3 与 signature 复用同一块纸（#paper / #tray 常驻） ----- */
function buildInk() {
  const sec = section('ink');

  S.inkTitle = el('h2', { class: 'h2' });
  S.rounds = el('div', { class: 'rounds', 'aria-hidden': 'true' });
  for (let i = 0; i < ROUND_TOTAL; i += 1) S.rounds.append(el('i'));
  S.inkDone = el('button', { type: 'button', class: 'btn primary tiny', 'data-next': '' });
  S.inkDone.addEventListener('click', onInkDone);
  S.inkBar = el('div', { class: 'inkbar', hidden: true }); // 落款屏把唯一前进键挪到这里（同坐标触区）

  S.inkHint = el('p', { class: 'hint' });

  S.paper = el('div', { id: 'paper' });
  const paperBox = el('div', { class: 'paperbox' }, S.paper);

  S.trayLabel = el('span', { class: 'traylabel', 'data-copy': 'sheet_tray' });
  S.tray = el('div', { id: 'tray', role: 'listbox' });
  S.tray.setAttribute('aria-label', t('sheet_tray'));
  const traybar = el('div', { class: 'traybar' }, S.trayLabel, S.tray);

  // 底部三个极简控件：墨色 / 大小 / 转（契约缺口：无对应 copy 键，用符号 + aria-label）
  S.undo = el('button', { type: 'button', class: 'btn ghost tiny', 'data-undo': '', 'data-copy': 'sheet_undo' });
  S.undo.addEventListener('click', () => {
    try { board && board.undo(); } catch (e) { /* ink 未就绪 */ }
  });
  S.inkAmt = rangeControl('墨色', '◐', 0, 1, 0.01, 0.68);
  S.inkScale = rangeControl('大小', '⤢', 0.4, 1.6, 0.01, 1);
  S.inkRot = rangeControl('转', '↻', -20, 20, 1, 0);
  S.tools = el('div', { class: 'tools' },
    S.undo,
    el('label', { class: 'tool' }, el('span', { class: 'ic', 'aria-hidden': 'true', text: '◐' }), S.inkAmt),
    el('label', { class: 'tool' }, el('span', { class: 'ic', 'aria-hidden': 'true', text: '⤢' }), S.inkScale),
    el('label', { class: 'tool' }, el('span', { class: 'ic', 'aria-hidden': 'true', text: '↻' }), S.inkRot),
  );

  S.curtainText = el('p', { class: 'curtain-text' });
  S.curtain = el('div', { class: 'curtain', hidden: true }, S.curtainText);
  S.curtain.addEventListener('click', () => curtainAdvance(true));

  S.inkHead = el('header', { class: 'inkhead' }, S.inkTitle, S.rounds, S.inkDone);
  sec.append(S.inkHead, S.inkHint, paperBox, traybar, S.tools, S.inkBar, S.curtain);
  stage.append(sec);
}

function rangeControl(label, _glyph, min, max, step, value) {
  const input = el('input', { type: 'range', min, max, step, value });
  input.setAttribute('aria-label', label);
  input.addEventListener('input', () => {
    if (!board) return;
    try {
      if (label === '墨色') board.setInk(Number(input.value));
      else if (label === '大小') board.setScale(Number(input.value));
      else if (label === '转') board.setRotation(Number(input.value));
    } catch (e) { /* ink 未就绪 */ }
  });
  return input;
}

/* --- 6.4 cards（C1：只由进入 cards 的动作创建；两张卡永不合并 C2） -------- */
function buildCards() {
  const sec = section('cards');

  // ① 变化卡：前测/后测三题条状对比 + 差值数字
  const changeCard = el('article', { class: 'card', 'data-card': 'change' });
  changeCard.append(
    el('div', { class: 'card-head' },
      el('h3', { 'data-copy': 'cards_change_title' }),
      el('div', { class: 'legend', 'aria-hidden': 'true' },
        el('i', { class: 'sw pre' }), el('span', { 'data-copy': 'pre_title' }),
        el('i', { class: 'sw' }), el('span', { 'data-copy': 'post_title' }),
      ),
    ),
  );
  S.changeBody = el('div', {});
  changeCard.append(S.changeBody);

  // ② 过程卡：每张纸 6 个主指标，其余「展开」
  const procCard = el('article', { class: 'card', 'data-card': 'process' });
  S.expandBtn = el('button', { type: 'button', class: 'expand', 'data-copy': 'cards_hint' });
  S.expandBtn.setAttribute('aria-expanded', 'false');
  S.expandBtn.addEventListener('click', () => {
    const open = S.more.hidden;
    S.more.hidden = !open;
    S.expandBtn.classList.toggle('on', open);
    S.expandBtn.setAttribute('aria-expanded', String(open));
  });
  procCard.append(
    el('div', { class: 'card-head' }, el('h3', { 'data-copy': 'cards_process_title' }), S.expandBtn),
  );
  S.procBody = el('div', {});
  S.more = el('div', { class: 'more', hidden: true });
  procCard.append(S.procBody, S.more);

  const foot = el('div', { class: 'screenbar' }, nextButton('pre_next', () => enterReplay()));
  sec.append(el('div', { class: 'cards' }, changeCard, procCard), foot);
  stage.append(sec);
  S.cards = sec;
}

/* --- 6.5 replay：三张横展（可横滑，不撑宽视口） --------------------------- */
function buildReplay() {
  const sec = section('replay');
  S.strip = el('div', { class: 'strip' });
  const nextBtn = nextButton('pre_next', () => onReplayNext());
  S.replayNext = nextBtn;
  sec.append(
    el('header', { class: 'replay-head' },
      el('h2', { class: 'h2', 'data-copy': 'replay_title' }),
      el('span', { class: 'hint', 'data-copy': 'replay_hint' }),
    ),
    S.strip,
    el('div', { class: 'screenbar' }, nextBtn),
  );
  stage.append(sec);
  S.replay = sec;
}

/* --- 6.6 done：导出 / 重来 ------------------------------------------------ */
function buildDone() {
  const sec = section('done');
  S.exportBtn = el('button', { type: 'button', class: 'btn primary', 'data-export': '', 'data-copy': 'done_export' });
  S.exportBtn.addEventListener('click', () => exportCsv());
  S.againBtn = el('button', { type: 'button', class: 'btn ghost', 'data-again': '', 'data-copy': 'done_again' });
  S.againBtn.addEventListener('click', () => location.reload());
  S.sid = el('div', { class: 'done-sid' });

  sec.append(
    el('h1', { class: 'h1', 'data-copy': 'done_title' }),
    el('div', { class: 'done-seal', 'aria-hidden': 'true' }),
    el('div', { class: 'done-actions' }, S.exportBtn, S.againBtn),
    S.sid,
  );
  stage.append(sec);
  S.done = sec;
}

/* ============================ 7. 状态机 ============================ */
const screenSection = {
  gate: () => S.sections[0],
  pre: () => S.sections[1],
  sheet: () => S.sections[2],
  signature: () => S.sections[2], // 与 sheet 共用同一块纸
  post: () => S.sections[3],
  cards: () => S.sections[4],
  replay: () => S.sections[5],
  done: () => S.sections[6],
};

/** 把「当前屏」的停留时长写进 steps（finish 在进 done 之前发，所以 replay 的时长要手动先落账） */
function closeStep() {
  if (!state.stepId) return;
  state.steps.push({ id: state.stepId, ms: Math.max(0, Math.round(Date.now() - state.stepAt)) });
  state.stepId = '';
  state.stepAt = Date.now();
}

/** 单向前进；#stage[data-screen] 与契约 §2 一一对应 */
function go(screen, stepId) {
  closeStep(); // 上一屏时长入 steps；同屏内已 close 过则不重复记
  state.screen = screen;
  state.stepId = stepId || screen;
  state.stepAt = Date.now();
  stage.dataset.screen = screen;
  if (screen !== 'sheet') delete stage.dataset.round;
  const active = screenSection[screen]();
  for (const sec of S.sections) sec.classList.toggle('active', sec === active);
}

/* ============================ 8. pre → sheet ============================ */
function onPreNext() {
  if (busy) return;
  const values = readAnswers('pre');
  if (!values) return;
  busy = true;
  state.pre = values;
  persist();
  submitState('pre', values); // 不阻塞：失败进 pending，done 前重试（§7）
  busy = false;
  enterSheet(1);
}

async function enterSheet(round) {
  state.round = round;
  go('sheet', `sheet${round}`);
  stage.dataset.round = String(round);
  S.rounds.hidden = false;
  updateRounds(round);
  S.inkTitle.textContent = t('sheet_title');
  S.inkHint.textContent = leadLine(round);
  S.inkDone.textContent = t('sheet_done');
  S.inkDone.setAttribute('data-round-done', '');
  S.inkBar.hidden = true;
  if (S.inkDone.parentElement !== S.inkHead) S.inkHead.append(S.inkDone);
  await ensureBoard();
  try { board.reset(round); } catch (e) { /* ink 未就绪 */ }
  wireTools(); // 纸面重置会把滑杆值恢复默认，这里把三个控件重新推给 ink
}

function updateRounds(round) {
  Array.from(S.rounds.children).forEach((dot, i) => {
    dot.classList.toggle('on', i < round);
  });
}

/** 每轮前 1 条引导（scripts.pre，≤16 字）；缺失退回 copy.sheet_hint */
function leadLine(round) {
  const line = lineFor(round);
  const text = line && line.pre ? String(line.pre) : '';
  return (text || t('sheet_hint')).slice(0, 16);
}

/** 收笔后 1 条承接（scripts.post，≤16 字） */
function catchLine(round) {
  const line = lineFor(round);
  return line && line.post ? String(line.post).slice(0, 16) : '';
}

/** 按 session_seed % n 选一条（契约 §3，可复现） */
function lineFor(round) {
  const lines = state.lines;
  if (!lines) return null;
  const arr = lines[String(round)] || lines[round];
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr[hash(state.session + ':' + round) % arr.length] || null;
}

function onInkDone() {
  if (busy) return;
  if (state.screen === 'sheet') finishSheet();
  else if (state.screen === 'signature') finishSignature();
}

function finishSheet() {
  if (busy) return;
  busy = true;
  const metrics = safeStats();
  let png = null;
  try { png = board && board.exportPng ? board.exportPng() : null; } catch (e) { png = null; }
  state.sheets.push({ round: state.round, metrics, png });
  persist();
  submitSheet(state.round, metrics).then(persist);

  const next = () => {
    busy = false;
    if (state.round < ROUND_TOTAL && state.condition === 'A') enterSheet(state.round + 1);
    else enterSignature();
  };
  const line = catchLine(state.round);
  if (line) curtainShow(line, next);
  else next();
}

/* 承接：卷轴式推入，≤16 字；点一下或 1.3s 后进下一张 */
let curtainTimer = 0;
let curtainNext = null;
function curtainShow(text, next) {
  curtainNext = next;
  S.curtainText.textContent = String(text).slice(0, 16);
  S.curtain.hidden = false;
  requestAnimationFrame(() => S.curtain.classList.add('show'));
  clearTimeout(curtainTimer);
  curtainTimer = setTimeout(() => curtainAdvance(false), RM ? 500 : 1300);
}
function curtainAdvance(byUser) {
  if (!curtainNext) return;
  clearTimeout(curtainTimer);
  S.curtain.classList.remove('show');
  const next = curtainNext;
  curtainNext = null;
  const wait = RM ? 0 : 200;
  setTimeout(() => {
    S.curtain.hidden = true;
    S.curtainText.textContent = ''; // 隐藏后清字：不给其它屏的字数统计留残影
    next();
  }, wait);
}

/* ============================ 9. signature → post ============================ */
async function enterSignature() {
  go('signature', 'signature');
  S.rounds.hidden = true;
  S.inkTitle.textContent = t('signature_title');
  S.inkHint.textContent = t('signature_hint');
  S.inkDone.textContent = t('signature_skip');
  S.inkDone.removeAttribute('data-round-done'); // 仅在 sheet 屏挂载，避免 e2e 选择器歧义
  S.inkBar.hidden = false;
  S.inkBar.append(S.inkDone);
  await ensureBoard();
  try { board.reset('signature'); } catch (e) { /* ink 未就绪 */ }
  wireTools();
}

function updateSigButton() {
  if (state.screen !== 'signature') return;
  let n = 0;
  try { n = Number(board && board.stats ? board.stats().pieces_used : 0) || 0; } catch (e) { n = 0; }
  S.inkDone.textContent = n > 0 ? t('sheet_done') : t('signature_skip');
}

function finishSignature() {
  if (busy) return;
  busy = true;
  try { state.sigStrokes = Math.max(0, Math.round(Number(board.stats().pieces_used) || 0)); } catch (e) { state.sigStrokes = 0; }
  persist();
  busy = false;
  enterPost();
}

function enterPost() {
  go('post', 'post');
}

/* ============================ 10. post → cards ============================ */
async function onPostNext() {
  if (busy) return;
  const values = readAnswers('post');
  if (!values) return;
  busy = true;
  state.post = values;
  persist();
  S.post.next.disabled = true;
  await submitState('post', values);

  /* C1（不可退让，融合规格 §7）：双卡必须严格在「后测提交之后」才出现。
     看到读数会改变后测作答（反应性），所以这里必须 await 提交；离线路径 await 的是
     「本地已封存」（§7 localStorage），同样是提交之后的等价物，绝不提前进 cards。 */
  busy = false;
  enterCards();
}

function enterCards() {
  go('cards', 'cards'); // C1：cards 只有这一处入口，且只被 onPostNext 的 await 之后调用
  fillCards();
}

function fillCards() {
  // ① 变化卡：三题条状对比 + 差值数字（状态族与过程族永不合并 C2）
  S.changeBody.textContent = '';
  const limit = state.limits.pre || FALLBACK_LIMIT;
  for (const q of ['q1', 'q2', 'q3']) {
    const preV = numOrNull(state.pre && state.pre[q]);
    const postV = numOrNull(state.post && state.post[q]);
    const preBar = el('i', { class: 'bar pre' });
    const postBar = el('i', { class: 'bar' });
    preBar.style.width = preV == null ? '0%' : `${clamp((preV / limit) * 100, 0, 100)}%`;
    postBar.style.width = postV == null ? '0%' : `${clamp((postV / limit) * 100, 0, 100)}%`;
    const delta = preV != null && postV != null ? postV - preV : null;
    S.changeBody.append(
      el('div', { class: 'crow' },
        el('span', { class: 'clabel', 'data-copy': `pre_${q}` }),
        el('div', { class: 'cbars' }, preBar, postBar),
        el('b', { class: 'cdelta', text: delta == null ? '—' : signed(delta) }),
      ),
    );
  }
  // 差异题面可能与 pre 不同（若后端分开写），这里按 pre 题面显示（J4 前后同构）

  // ② 过程卡：主读 6 项；指标名用 §4 字段名（R4），不自造文案
  S.procBody.textContent = '';
  const sheets = state.sheets;
  const headRow = el('div', { class: 'prow head' }, el('span', { class: 'pname', text: '·' }),
    ...sheets.map((s) => el('span', { class: 'pval', text: String(s.round) })));
  S.procBody.append(headRow);
  for (const key of METRIC_MAIN) {
    S.procBody.append(el('div', { class: 'prow' },
      el('span', { class: 'pname', text: key }),
      ...sheets.map((s) => metricCell(key, s.metrics[key])),
    ));
  }
  S.more.textContent = '';
  for (const key of METRIC_REST) {
    S.more.append(el('div', { class: 'prow' },
      el('span', { class: 'pname', text: key }),
      ...sheets.map((s) => metricCell(key, s.metrics[key])),
    ));
  }
  // 轮间差（折叠区，不参与求和）：第 2/3 列 = 相邻两张纸的差
  for (const key of METRIC_MAIN.slice(0, 3)) {
    S.more.append(el('div', { class: `prow delta${key === METRIC_MAIN[0] ? ' first' : ''}` },
      el('span', { class: 'pname', text: `Δ${key}` }),
      ...sheets.map((s, i) => {
        if (i === 0) return el('span', { class: 'pval', text: '' });
        const va = numOrNull(sheets[i - 1].metrics[key]);
        const vb = numOrNull(s.metrics[key]);
        return el('span', { class: 'pval', text: va != null && vb != null ? signed(vb - va) : '—' });
      }),
    ));
  }
  S.more.hidden = true;
  S.expandBtn.classList.remove('on');
  S.expandBtn.setAttribute('aria-expanded', 'false');
}

/** 指标单元格：数组（hue_used）画 5 根色条，其余是数字；避免长数组撑破 40px 列 */
function metricCell(key, value) {
  if (Array.isArray(value)) {
    const nums = value.map((n) => (Number.isFinite(+n) ? Math.abs(+n) : 0));
    const max = Math.max(1, ...nums);
    const wrap = el('span', { class: 'pval huebars' });
    wrap.setAttribute('aria-label', `hue_used ${nums.join(' ')}`);
    for (let i = 0; i < 5; i += 1) {
      const bar = el('i', { class: `hb hb${i}`, 'aria-hidden': 'true' });
      bar.style.height = `${Math.max(2, Math.round((nums[i] / max) * 11))}px`;
      bar.style.opacity = nums[i] ? '1' : '.16';
      wrap.append(bar);
    }
    return wrap;
  }
  return el('span', { class: 'pval', text: fmtMetric(key, value) });
}

function fmtMetric(key, value) {
  if (value == null) return '—';
  if (Array.isArray(value)) return value.join('·');
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (key === 'pieces_used' || key === 'undo_count' || key === 'reposition_count'
    || key === 'first_place_ms' || key === 'active_ms' || key === 'groups_used'
    || key === 'group_switches' || key === 'first_group') return String(Math.round(n));
  return n.toFixed(2);
}

function signed(n) {
  const v = Math.round(n * 10) / 10;
  if (v > 0) return `+${v.toFixed(1)}`;
  if (v < 0) return `−${Math.abs(v).toFixed(1)}`;
  return '0.0';
}

/* ============================ 11. replay → done ============================ */
function enterReplay() {
  go('replay', 'replay');
  S.strip.textContent = '';
  for (const s of state.sheets) {
    const fig = el('figure', {});
    if (s.png) fig.append(el('img', { src: s.png, alt: '' }));
    else fig.append(el('div', { class: 'empty', text: String(s.round) }));
    fig.append(el('figcaption', { text: `${s.round}/${state.condition === 'B' ? 1 : ROUND_TOTAL}` }));
    S.strip.append(fig);
  }
  persist();
}

async function onReplayNext() {
  if (busy) return;
  busy = true;
  S.replayNext.disabled = true;
  closeStep(); // replay 的停留时长先入 steps（finish 在进 done 前发出）
  await finishSession();
  busy = false;
  enterDone();
}

function enterDone() {
  go('done', 'done');
  state.finishedAt = state.finishedAt || Date.now();
  S.sid.textContent = state.session;
  persist();
}

/* ============================ 12. 提交 / 降级 / 导出 ============================ */
async function submitState(phase, values) {
  if (!state.remoteSession) return false;
  try {
    await api(`/api/session/${encodeURIComponent(state.session)}/state`, { method: 'POST', body: { phase, values } });
    state.pending = state.pending.filter((p) => !(p.kind === 'state' && p.phase === phase));
    return true;
  } catch (e) {
    if (!state.pending.some((p) => p.kind === 'state' && p.phase === phase)) {
      state.pending.push({ kind: 'state', phase, values });
    }
    return false;
  } finally {
    persist();
  }
}

async function submitSheet(round, metrics) {
  if (!state.remoteSession) return false;
  try {
    await api(`/api/session/${encodeURIComponent(state.session)}/sheet`, { method: 'POST', body: { round, metrics } });
    state.pending = state.pending.filter((p) => !(p.kind === 'sheet' && p.round === round));
    return true;
  } catch (e) {
    if (!state.pending.some((p) => p.kind === 'sheet' && p.round === round)) {
      state.pending.push({ kind: 'sheet', round, metrics });
    }
    return false;
  } finally {
    persist();
  }
}

async function flushPending() {
  for (const p of [...state.pending]) {
    try {
      if (p.kind === 'state') {
        await api(`/api/session/${encodeURIComponent(state.session)}/state`, { method: 'POST', body: { phase: p.phase, values: p.values } });
      } else {
        await api(`/api/session/${encodeURIComponent(state.session)}/sheet`, { method: 'POST', body: { round: p.round, metrics: p.metrics } });
      }
      state.pending = state.pending.filter((x) => x !== p);
    } catch (e) { /* 继续重试 */ }
  }
  return state.pending.length === 0;
}

/** 进 done 之前：先补发挂起项，finish 最多 3 次（首轮 + 2 次重试，§7）；仍失败 → 本地 CSV */
async function finishSession() {
  state.finishedAt = state.finishedAt || Date.now();
  if (!state.remoteSession) {
    state.localExport = true;
    persist();
    return;
  }
  let ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt += 1) {
    if (attempt) await sleep(400 * attempt);
    await flushPending();
    try {
      const res = await api(`/api/session/${encodeURIComponent(state.session)}/finish`, {
        method: 'POST',
        body: {
          signature: { strokes: Math.max(0, Math.round(Number(state.sigStrokes) || 0)) },
          steps: state.steps.map((s) => ({ id: String(s.id), ms: Math.max(0, Math.round(s.ms)) })),
        },
      });
      state.csvUrl = (res && res.csv_url) || '/api/export.csv';
      state.localExport = false;
      ok = true;
    } catch (e) { /* 下一轮 */ }
  }
  if (!ok) state.localExport = true;
  persist();
}

function persist() {
  try {
    const rec = {
      session_id: state.session,
      condition: state.condition,
      started_at: new Date(state.startedAt).toISOString(),
      finished_at: state.finishedAt ? new Date(state.finishedAt).toISOString() : null,
      signature_strokes: state.sigStrokes,
      pre: state.pre,
      post: state.post,
      sheets: state.sheets.map((s) => ({ round: s.round, metrics: s.metrics })),
      steps: state.steps,
      remote: state.remoteSession,
      pending: state.pending,
      offline: state.offline,
    };
    localStorage.setItem(`inkfusion:${state.session}`, JSON.stringify(rec));
  } catch (e) { /* 隐私模式/配额 */ }
}

async function exportCsv() {
  const btn = S.exportBtn;
  if (btn) btn.disabled = true;
  try {
    if (!state.localExport && state.csvUrl) {
      try {
        const res = await fetch(API_BASE + state.csvUrl, { cache: 'no-store', credentials: 'same-origin' });
        if (!res.ok) throw new Error(`csv → ${res.status}`);
        const text = await res.text();
        download(`ink-fusion-${safeName(state.session)}.csv`, text);
        return;
      } catch (e) {
        state.localExport = true; // 导出改本地 CSV（§7）
      }
    }
    download(`ink-fusion-${safeName(state.session)}.csv`, localCsv());
  } finally {
    if (btn) btn.disabled = false;
  }
}

function safeName(id) {
  return String(id || 'session').replace(/[^\w.-]+/g, '_').slice(0, 48);
}

function download(name, text) {
  const blob = new Blob([`\ufeff${text}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function localCsv() {
  const pre = state.pre || {};
  const post = state.post || {};
  const head = ['session_id', 'condition', 'started_at', 'finished_at', 'duration_seconds', 'signature_strokes'];
  for (const k of ['q1', 'q2', 'q3']) head.push(`state_pre_${k}`);
  for (const k of ['q1', 'q2', 'q3']) head.push(`state_post_${k}`);
  for (const k of ['q1', 'q2', 'q3']) head.push(`state_delta_${k}`);
  head.push('state_post_ux1', 'state_post_ux2');
  for (const s of state.sheets) for (const k of METRIC_KEYS) head.push(`sheet${s.round}_${k}`);
  head.push('step_seconds');

  const row = [state.session, state.condition, new Date(state.startedAt).toISOString(),
    state.finishedAt ? new Date(state.finishedAt).toISOString() : '',
    state.finishedAt ? (state.finishedAt - state.startedAt) / 1000 : '', state.sigStrokes];
  for (const k of ['q1', 'q2', 'q3']) row.push(pre[k] == null ? '' : pre[k]);
  for (const k of ['q1', 'q2', 'q3']) row.push(post[k] == null ? '' : post[k]);
  for (const k of ['q1', 'q2', 'q3']) {
    row.push(pre[k] != null && post[k] != null ? Number(post[k]) - Number(pre[k]) : '');
  }
  row.push(post.ux1 == null ? '' : post.ux1, post.ux2 == null ? '' : post.ux2);
  for (const s of state.sheets) {
    for (const k of METRIC_KEYS) {
      const v = s.metrics ? s.metrics[k] : null;
      row.push(Array.isArray(v) ? v.join('|') : (v == null ? '' : v));
    }
  }
  row.push(state.steps.map((s) => `${s.id}:${s.ms}`).join('|'));

  return `${head.map(csvCell).join(',')}\r\n${row.map(csvCell).join(',')}\r\n`;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ============================ 13. ink.js（契约 §5，唯一画布来源） ============================ */
const STUB_PIECES = Array.from({ length: 19 }, (_, i) => ({
  id: `b${String(i + 1).padStart(2, '0')}`,
  group: i < 7 ? 0 : i < 13 ? 1 : 2,
  name: `墨块${i + 1}`,
}));

/** 仅在 ink.js 尚未就绪时用于自验的占位板：不画任何墨、不替代 ink.js（联调时会被真实模块替换） */
function createStubBoard(root) {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 560;
  root.append(canvas);
  root.dataset.ink = 'stub';
  const ctx = canvas.getContext('2d');
  const paint = () => {
    ctx.fillStyle = '#ece6d8';
    ctx.fillRect(0, 0, 800, 560);
  };
  paint();
  let placed = 0;
  return {
    mount() { paint(); },
    reset() { placed = 0; paint(); },
    render() { paint(); },
    undo() { return false; },
    clear() { paint(); },
    setInk() {},
    setScale() {},
    setHue() {},
    setRotation() {},
    selectPiece() { placed += 1; },
    stats() {
      return {
        pieces_used: placed, blank_ratio: placed ? 0.72 : 1, center_bias: 0, ink_mean: 0.68,
        ink_sd: 0.04, hue_used: [0, 0, 0, 0, 0], undo_count: 0, reposition_count: 0,
        first_place_ms: 0, active_ms: 0, scale_mean: 1, scale_range: 0,
        groups_used: placed ? 1 : 0, group_switches: 0, first_group: placed ? 0 : null,
      };
    },
    exportPng() { return canvas.toDataURL('image/png'); },
    on() {},
  };
}

let trayRendered = false;
let toolsWired = false;

async function ensureBoard() {
  if (board) return board;
  let mod = null;
  try {
    mod = await import('./ink.js');
  } catch (e) {
    console.warn('[shell] web/ink.js 未就绪，使用占位板自验（联调时自动切换为真实墨引擎）', e);
  }
  let made = null;
  if (mod && typeof mod.createBoard === 'function') {
    try {
      made = mod.createBoard(S.paper, {
        reducedMotion: RM,
        dpr: Math.min(window.devicePixelRatio || 1, 2),
        piecesPerRound: 19,
      });
    } catch (e) {
      console.warn('[shell] createBoard 失败', e);
      made = null;
    }
  }
  board = made || createStubBoard(S.paper);
  PIECES = Array.isArray(mod && mod.PIECES) && mod.PIECES.length === 19 ? mod.PIECES : STUB_PIECES;
  try { board.mount(); } catch (e) { /* 已由 createBoard 挂载 */ }
  try { board.on && board.on('change', onInkChange); } catch (e) { /* 可选 */ }
  if (!trayRendered) { renderTray(); trayRendered = true; }
  if (!toolsWired) { wireTools(); toolsWired = true; }
  return board;
}

/** ink 的取块/放回/落墨/重置会改 hand（§5 不直接暴露），这里用 change 事件同步托盘高亮 + 落款按钮 */
function onInkChange(ev) {
  const action = ev && ev.action;
  if (action === 'pick' && ev.piece) markChip(ev.piece);
  else if (action === 'disarm' || action === 'place' || action === 'clear' || action === 'reset') clearChipMarks();
  updateSigButton();
}

function markChip(id) {
  S.tray.querySelectorAll('.chip').forEach((chip) => {
    const on = chip.dataset.piece === String(id);
    chip.classList.toggle('on', on);
    chip.setAttribute('aria-selected', String(on));
  });
}

function clearChipMarks() {
  S.tray.querySelectorAll('.chip.on').forEach((chip) => {
    chip.classList.remove('on');
    chip.setAttribute('aria-selected', 'false');
  });
}

function selectPiece(id) {
  try { if (board && board.selectPiece) board.selectPiece(id); } catch (e) { /* noop */ }
}

function wireTools() {
  try { board.setInk(Number(S.inkAmt.value)); } catch (e) { /* noop */ }
  try { board.setScale(Number(S.inkScale.value)); } catch (e) { /* noop */ }
  try { board.setRotation(Number(S.inkRot.value)); } catch (e) { /* noop */ }
}

function renderTray() {
  S.tray.textContent = '';
  let lastGroup = null;
  for (const piece of PIECES) {
    const group = Number.isInteger(piece.group) ? piece.group : 0;
    if (lastGroup !== null && group !== lastGroup) {
      S.tray.append(el('i', { class: 'tsep', 'aria-hidden': 'true' }));
    }
    lastGroup = group;
    const chip = el('button', {
      type: 'button',
      class: 'chip',
      'data-piece': String(piece.id),
      'data-group': String(group),
      role: 'option',
      'aria-selected': 'false',
    });
    chip.setAttribute('aria-label', piece.name || String(piece.id));
    chip.addEventListener('click', () => selectPiece(piece.id));
    S.tray.append(chip);
  }
}

/** 只把 §4 字段原样打包，并做一次防御性数值化（不采信的字段不写入） */
function safeStats() {
  let raw = {};
  try { raw = (board && board.stats && board.stats()) || {}; } catch (e) { raw = {}; }
  const out = {};
  for (const key of METRIC_KEYS) {
    const v = raw[key];
    if (key === 'first_group' && (v == null || v === '')) { out[key] = null; continue; }
    if (Array.isArray(v)) { out[key] = v.map((n) => (Number.isFinite(+n) ? +n : 0)); continue; }
    out[key] = Number.isFinite(+v) ? +v : 0;
  }
  return out;
}

/* ============================ 14. go! ============================ */
window.__shell = {
  get screen() { return state.screen; },
  get board() { return board; },
  state,
};
boot().catch((err) => {
  console.error('[shell] boot 失败', err);
  document.body.classList.remove('booting');
});
