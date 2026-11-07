/* =====================================================================
 * 墨引擎 · ink.js — 「三张」摆墨的渲染内核（独立 ESM，无依赖、无构建）
 * =====================================================================
 * 唯一真源：app/shared/contract.md §4（过程指标）§5（接口）
 * 只写这一份渲染实现；server / shell / tests 都不碰这里。
 *
 * 三条必须保住的手艺（来自墨心 index.html 的调参结果，重写成可维护模块）：
 *
 *  1) 边缘衰减靠「多遍低 alpha 叠加」，**不用 ctx.filter / blur**。
 *     教训（墨心 README「踩过的坑」#1）：Chromium 给带 filter 的绘制开的临时层
 *     按路径包围盒裁，模糊本该洇出包围盒的部分被切掉，纸上多出一圈矩形硬边。
 *     这里把一块墨拆成 7 层，层权 1/2, 1/4, 1/8, …, 1/128（等比减半），
 *     每层再拆成若干遍「低 alpha + 小幅随机位移」，层内单遍 alpha 压到 ≤8%
 *     （单遍 alpha 就是肉眼看到的台阶高度，墨心的实测结论：>8% 能看出层叠）。
 *     第一层是湿晕（更远、更淡），第二段是主体衰减，第三段是骨（收紧的芯），
 *     最后一段是飞白（destination-out 擦出丝状白缝）。
 *
 *  2) 飞白随墨色递增。淡墨含水多、笔迹匀；浓墨稠、笔毛一分就露纸。
 *     墨心把公式写反过一次（(1-ink)），最淡的档反而刮出三条平行白缝。
 *     这里的飞白在**预渲染时**按 canonical 墨色烘进纹理，落位时整体再乘
 *     globalAlpha（墨色滑杆）：墨越浓 → globalAlpha 越大 → 白缝越显；
 *     墨越淡 → 整体越淡 → 白缝随之消失。方向沿笔画切向（用 pts 的切线，
 *     不是按块坐标轴随机），且按笔画长度加权分配，不平均主义。
 *
 *  3) 像素读数只在 stats() 里 getImageData 一次，禁止每帧读回。
 *     render() 的每一帧只做 drawImage + transform + globalAlpha。
 *
 * 性能红线（决定成败）：
 *    19 块 × 5 色 = 95 张离屏纹理，**只在 mount() 里预渲染一次**。
 *    落位/拖动/换墨色/换大小/转动 全程零重绘纹理，只有 drawImage。
 *    getImageData 仅出现在 stats()（导出 PNG 用 toDataURL，同样不读回）。
 *
 * 契约要点（§5）：
 *    export function createBoard(rootEl, opts = {}) -> board
 *    board.mount() / reset(round) / render() / undo() / clear()
 *    board.setInk(v01) / setScale(v) / setHue(i) / setRotation(deg)
 *    board.selectPiece(pieceId) / stats() / exportPng() / on('change', cb)
 *    opts: { width=800, height=560, dpr=2, reducedMotion=false, piecesPerRound=19 }
 *    export const PIECES = [{ id, group:0|1|2, name }]   // 19 块
 * ===================================================================== */

/* =====================================================================
 * §0 常量（契约里出现的数字只在这里写一次）
 * ===================================================================== */

const LOGICAL = Object.freeze({ width: 800, height: 560 }); // 纸的逻辑尺寸
const DEFAULT_DPR = 2;
const DEFAULT_INK = 0.68;      // 墨色滑杆默认档（墨心的默认值）
const DEFAULT_SCALE = 1;
const SCALE_MIN = 0.4;         // 大小滑杆下限（对齐 shell 的 0.4–1.6；墨心原档 0.5–1.8）
const SCALE_MAX = 1.8;
const INK_MIN = 0;
const INK_MAX = 1;

const FADE_MS = 420;           // 落墨晕开时长（融合规格「墨的物性」；reducedMotion 下为 0）
const FADE_START = 0.45;       // 晕开起始不透明度比例
const ACTIVE_GAP_MS = 10000;   // active_ms 去掉 >10s 的空档（泡茶时间不算动手）
const INK_PIXEL_ALPHA = 0.06;  // 算「落过墨」的 alpha 阈值（与墨心一致）
const WEIGHT_ALPHA = 0.02;     // 算重心时每个像素的 alpha 权重阈值

/* 传统国画五色。色相在渲染里的唯一作用：把 fillStyle 从墨色换成这一色。
 * f 是「同一支滑杆下的视觉重量补偿」——赭石/藤黄在纸上比墨轻，不抬 alpha
 * 会显得没蘸饱；这组数是墨心逐色目检调过的，不是推出来的。
 * 色号顺序 = contract §4 hue_used 的数组顺序：墨 / 赭石 / 花青 / 藤黄 / 朱砂。
 * 没有一个字是「颜色 → 情绪」：用色只记录，不解释。 */
const HUES = Object.freeze([
  { id: 'mo', name: '墨', css: '#1a1a18', f: 1.00 },
  { id: 'zheshi', name: '赭石', css: '#a35a2e', f: 1.30 },
  { id: 'huaqing', name: '花青', css: '#31556f', f: 1.04 },
  { id: 'tenghuang', name: '藤黄', css: '#b9902a', f: 1.62 },
  { id: 'zhusha', name: '朱砂', css: '#a83a2c', f: 1.14 },
]);

const PAPER_TONE = '#f7f4ec';
const INK_BLACK = '#1a1a18';

/* =====================================================================
 * §1 可复现随机（mulberry32）
 * 每块墨一个固定种子 ⇒ 三张之间素材同构（墨心 X1），轮间差才归因得到人身上。
 * ===================================================================== */

function mulberry32(a) {
  let s = a >>> 0;
  return function random() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* =====================================================================
 * §2 笔法：一笔 = 平滑脊线 + 沿程宽度
 *   山、石、点、雾、树干、屋柱、人腿，全部是同一笔的不同参数。
 *   宽度沿 t 单向渐变（不折返）⇒ 法线不突变，不会出现「两条腿」。
 * ===================================================================== */

const NPT = 52; // 一笔的采样点数

function catmull(ctrl, n) {
  const P = [ctrl[0], ...ctrl, ctrl[ctrl.length - 1]];
  const segs = ctrl.length - 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * segs;
    const s = Math.min(Math.floor(t), segs - 1);
    const u = t - s;
    const p0 = P[s];
    const p1 = P[s + 1];
    const p2 = P[s + 2];
    const p3 = P[s + 3];
    const f = (a, b, c, d) =>
      0.5 *
      (2 * b +
        (-a + c) * u +
        (2 * a - 5 * b + 4 * c - d) * u * u +
        (-a + 3 * b - 3 * c + d) * u * u * u);
    out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
  }
  return out;
}

/* 拱形一笔（远山 / 雾 / 石 / 苔点）：起止默认随机，给了 xa/xb 就按给的放。
 * spindle != null 时宽度走纺锤形（点 / 石 / 雾）——等宽笔的轮廓本质是矩形，
 * 渲染出来会塌成橡皮擦印。 */
function buildArc(rnd, w, h, o) {
  const x0 = w * (o.xa != null ? o.xa : 0.02 + rnd() * 0.07);
  const x1 = w * (o.xb != null ? o.xb : 0.91 + rnd() * 0.07);
  const baseY = h * (o.base + (o.baseVar ? (rnd() - 0.5) * o.baseVar : 0));
  const px = w * (o.px != null ? o.px : 0.28 + rnd() * 0.44);
  const rise = h * o.rise * (0.82 + rnd() * 0.36);
  const wMax = h * o.thick * (0.86 + rnd() * 0.28);
  const taper = o.taper == null ? 0.72 : o.taper;
  const ctrl = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    const x = x0 + (x1 - x0) * t;
    const u = (x - px) / (w * 0.44);
    ctrl.push({ x, y: baseY - rise * Math.exp(-u * u * 1.7) + (rnd() - 0.5) * h * 0.012 });
  }
  const pts = catmull(ctrl, NPT);
  const widths = new Array(NPT);
  for (let i = 0; i < NPT; i++) {
    const t = i / (NPT - 1);
    let k;
    if (o.spindle != null) {
      k = Math.pow(Math.sin(Math.PI * (0.02 + 0.96 * t)), o.spindle);
    } else {
      k = o.flip ? 1 - taper + taper * t : 1 - taper * Math.pow(t, 0.9);
      // 两端收锋：起笔藏锋、收笔出锋。不收的话端点会是个秃头。
      if (t < 0.12) k *= 0.22 + 0.78 * (t / 0.12);
      if (t > 0.9) k *= 0.22 + 0.78 * ((1 - t) / 0.1);
    }
    widths[i] = Math.max(1.2, wMax * k * (0.86 + rnd() * 0.28));
  }
  return { pts, widths };
}

/* 定向一笔（树干 / 枝 / 屋柱 / 屋檐 / 人腿）：起止由参数给死，可带正弦弓。
 * thick 按块的长边算 —— 按高度算的话竖笔会被高度放大成柱子。 */
function buildSeg(rnd, w, h, base, o) {
  const ax = w * o.x0;
  const ay = h * o.y0;
  const bx = w * o.x1;
  const by = h * o.y1;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const bow = (o.bow || 0) * len;
  const wMax = base * o.thick * (0.86 + rnd() * 0.28);
  const taper = o.taper == null ? 0.6 : o.taper;
  const ctrl = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    const k = Math.sin(Math.PI * t) * bow; // 两端 0 ⇒ 起收笔仍落在给定的 A、B 上
    ctrl.push({ x: ax + dx * t + nx * k, y: ay + dy * t + ny * k + (rnd() - 0.5) * base * 0.01 });
  }
  const pts = catmull(ctrl, NPT);
  const widths = new Array(NPT);
  for (let i = 0; i < NPT; i++) {
    const t = i / (NPT - 1);
    let k = o.flip ? 1 - taper + taper * t : 1 - taper * Math.pow(t, 0.9);
    if (t < 0.12) k *= 0.22 + 0.78 * (t / 0.12);
    if (t > 0.9) k *= 0.22 + 0.78 * ((1 - t) / 0.1);
    widths[i] = Math.max(1, wMax * k * (0.88 + rnd() * 0.24));
  }
  return { pts, widths };
}

/* 描成一笔：两条侧轮廓合成闭合多边形（端点由收锋自然处理，不加端帽） */
function traceShape(ctx, shape) {
  const pts = shape.pts;
  const widths = shape.widths;
  const n = pts.length;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(i - 1, 0)];
    const b = pts[Math.min(i + 1, n - 1)];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const hw = Math.max(0.6, widths[i] / 2);
    const x = pts[i].x - dy * hw;
    const y = pts[i].y + dx * hw;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  for (let i = n - 1; i >= 0; i--) {
    const a = pts[Math.max(i - 1, 0)];
    const b = pts[Math.min(i + 1, n - 1)];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const hw = Math.max(0.6, widths[i] / 2);
    ctx.lineTo(pts[i].x + dy * hw, pts[i].y - dx * hw);
  }
  ctx.closePath();
  ctx.fill();
}

/* =====================================================================
 * §3 牌面：19 块全部代码绘制（无外部图片、无掩膜位图）
 *   分组照墨心 README：远景 4 / 中景 6 / 点缀 9（= 4 远 + 5 中 + 3 点，其余补足）。
 *   造型参照《芥子园画谱》点景谱（山石 / 树法 / 点叶 / 亭台 / 人物），但形状
 *   全部由本文件用 §2 的笔法现画；每块一个固定 seed ⇒ 三张同构。
 *
 *   参数（比例都相对「内缩区」，见 §4）：
 *     arc  一条拱：base 基线 / rise 拱高 / thick 笔宽 / xa,xb 横向起止 / px 峰值 / spindle 纺锤指数
 *     seg  定向一笔：x0,y0 → x1,y1 / thick 笔宽 / taper 收锋 / bow 弓 / flip 反向收锋
 *   taper 是负数时笔身向末端变粗（衣摆、石脚就靠它）。
 * ===================================================================== */

const SPECS = [
  /* ---------------- 远景（group 0）---------------- */
  {
    id: 'far-peak', group: 0, name: '远山·主峰', w: 300, h: 156, seed: 1101,
    parts: [{ k: 'arc', base: 0.8, baseVar: 0.06, rise: 0.54, thick: 0.2, taper: 0.62 }],
  },
  {
    id: 'far-ridge', group: 0, name: '远山·侧峰', w: 196, h: 108, seed: 1102,
    parts: [{ k: 'arc', base: 0.8, baseVar: 0.06, rise: 0.5, thick: 0.22, taper: 0.62, flip: true }],
  },
  {
    id: 'far-cloud', group: 0, name: '云雾', w: 320, h: 120, seed: 1110, soft: true,
    parts: [
      // 一条云是一缕，不是一块：几条横向错开、彼此叠一点的细缕，外缘才散得开。
      { k: 'arc', xa: 0.02, xb: 0.5, base: 0.42, baseVar: 0.1, rise: 0.04, thick: 0.36, spindle: 0.32, px: 0.42 },
      { k: 'arc', xa: 0.3, xb: 0.72, base: 0.56, baseVar: 0.1, rise: 0.04, thick: 0.3, spindle: 0.32, px: 0.5 },
      { k: 'arc', xa: 0.58, xb: 0.98, base: 0.48, baseVar: 0.1, rise: 0.04, thick: 0.26, spindle: 0.32, px: 0.6 },
      { k: 'arc', xa: 0.14, xb: 0.42, base: 0.68, baseVar: 0.08, rise: 0.03, thick: 0.16, spindle: 0.3, px: 0.5 },
    ],
  },
  {
    id: 'far-wave', group: 0, name: '水纹', w: 278, h: 40, seed: 1112,
    parts: [
      // 不等距、长短参差、每段都带可见的波 —— 不许读成「几条平行直线」。
      { k: 'arc', xa: 0.02, xb: 0.4, base: 0.28, rise: 0.35, thick: 0.075, taper: 0.45 },
      { k: 'arc', xa: 0.48, xb: 0.78, base: 0.3, rise: 0.3, thick: 0.068, taper: 0.45 },
      { k: 'arc', xa: 0.1, xb: 0.34, base: 0.48, rise: 0.3, thick: 0.062, taper: 0.5 },
      { k: 'arc', xa: 0.4, xb: 0.76, base: 0.52, rise: 0.38, thick: 0.068, taper: 0.45 },
      { k: 'arc', xa: 0.66, xb: 0.96, base: 0.55, rise: 0.35, thick: 0.055, taper: 0.5 },
      { k: 'arc', xa: 0.04, xb: 0.3, base: 0.7, rise: 0.28, thick: 0.055, taper: 0.5 },
      { k: 'arc', xa: 0.34, xb: 0.62, base: 0.74, rise: 0.34, thick: 0.062, taper: 0.45 },
      { k: 'arc', xa: 0.7, xb: 0.95, base: 0.78, rise: 0.26, thick: 0.05, taper: 0.5 },
    ],
  },

  /* ---------------- 中景（group 1）---------------- */
  {
    id: 'mid-rock', group: 1, name: '盘石', w: 152, h: 112, seed: 1105,
    parts: [{ k: 'arc', base: 0.56, baseVar: 0.08, rise: 0.08, thick: 0.84, spindle: 0.38, px: 0.46 }],
  },
  {
    id: 'mid-pebble', group: 1, name: '卵石', w: 108, h: 84, seed: 1106,
    parts: [{ k: 'arc', base: 0.56, baseVar: 0.08, rise: 0.06, thick: 0.88, spindle: 0.38, px: 0.52, flip: true }],
  },
  {
    id: 'mid-slope', group: 1, name: '土坡', w: 286, h: 163, seed: 1113,
    parts: [
      { k: 'arc', xa: 0.02, xb: 0.98, base: 0.72, baseVar: 0.04, rise: 0.1, thick: 0.6, spindle: 0.42, px: 0.52 },
      // 坡脊线压在坡体上沿（不能悬在半空——悬空就成了一根浮着的横线）
      { k: 'arc', xa: 0.06, xb: 0.62, base: 0.46, rise: 0.16, thick: 0.045, taper: 0.5 },
      { k: 'arc', xa: 0.56, xb: 0.86, base: 0.42, rise: 0.12, thick: 0.04, taper: 0.5 },
      // 左侧再压一层矮坡，坡才有前后层次
      { k: 'arc', xa: 0.02, xb: 0.36, base: 0.56, baseVar: 0.03, rise: 0.09, thick: 0.36, spindle: 0.42, px: 0.4 },
    ],
  },
  {
    id: 'mid-tree', group: 1, name: '古树', w: 168, h: 252, seed: 1103,
    parts: [
      // 树冠必须是「一簇点」（点叶法），不能是几条弧：弧之间是断的，树干够不着冠。
      { k: 'seg', x0: 0.52, y0: 0.98, x1: 0.47, y1: 0.4, thick: 0.07, taper: 0.52, bow: 0.02 },
      { k: 'seg', x0: 0.49, y0: 0.66, x1: 0.22, y1: 0.42, thick: 0.032, taper: 0.4, bow: 0.03 },
      { k: 'seg', x0: 0.48, y0: 0.56, x1: 0.78, y1: 0.36, thick: 0.032, taper: 0.4, bow: -0.03 },
      { k: 'arc', xa: 0.1, xb: 0.44, base: 0.3, baseVar: 0.08, rise: 0.03, thick: 0.13, spindle: 0.32, px: 0.5 },
      { k: 'arc', xa: 0.36, xb: 0.72, base: 0.2, baseVar: 0.08, rise: 0.03, thick: 0.14, spindle: 0.32, px: 0.5 },
      { k: 'arc', xa: 0.58, xb: 0.94, base: 0.32, baseVar: 0.08, rise: 0.03, thick: 0.12, spindle: 0.32, px: 0.5 },
      { k: 'arc', xa: 0.26, xb: 0.6, base: 0.4, baseVar: 0.08, rise: 0.03, thick: 0.13, spindle: 0.32, px: 0.5 },
      { k: 'arc', xa: 0.48, xb: 0.84, base: 0.46, baseVar: 0.08, rise: 0.03, thick: 0.11, spindle: 0.32, px: 0.5 },
    ],
  },
  {
    id: 'mid-willow', group: 1, name: '垂柳', w: 268, h: 185, seed: 1114,
    parts: [
      // 垂柳 = 主干 + 两条上枝 + 一团点叶的冠 + 一束「几乎竖直下垂」的柳丝。
      // 早先的错法：让垂丝从顶点向四面放射 ⇒ 渲染出来是一只爪子/一把伞。
      // 这一版：冠用一圈小点叶围成圆罩（不是一根横杠），垂丝只带一点点弓。
      { k: 'seg', x0: 0.5, y0: 0.98, x1: 0.49, y1: 0.24, thick: 0.07, taper: 0.45, bow: 0.02 },
      { k: 'seg', x0: 0.49, y0: 0.4, x1: 0.36, y1: 0.2, thick: 0.026, taper: 0.5, bow: -0.04 },
      { k: 'seg', x0: 0.49, y0: 0.38, x1: 0.64, y1: 0.18, thick: 0.026, taper: 0.5, bow: 0.04 },
      // 冠：一圈点叶（上沿 + 中段 + 两侧），围成圆罩
      { k: 'arc', xa: 0.36, xb: 0.48, base: 0.2, baseVar: 0.04, rise: 0.02, thick: 0.08, spindle: 0.3, px: 0.5 },
      { k: 'arc', xa: 0.48, xb: 0.6, base: 0.18, baseVar: 0.04, rise: 0.02, thick: 0.08, spindle: 0.3, px: 0.5 },
      { k: 'arc', xa: 0.34, xb: 0.44, base: 0.3, baseVar: 0.04, rise: 0.02, thick: 0.075, spindle: 0.3, px: 0.5 },
      { k: 'arc', xa: 0.6, xb: 0.7, base: 0.3, baseVar: 0.04, rise: 0.02, thick: 0.07, spindle: 0.3, px: 0.5 },
      { k: 'arc', xa: 0.44, xb: 0.56, base: 0.26, baseVar: 0.04, rise: 0.02, thick: 0.075, spindle: 0.3, px: 0.5 },
      { k: 'arc', xa: 0.5, xb: 0.62, base: 0.4, baseVar: 0.04, rise: 0.02, thick: 0.06, spindle: 0.3, px: 0.5 },
      // 柳丝：从冠沿垂下来，末端只外偏一点点（这是「垂」不是「放射」）
      { k: 'seg', x0: 0.36, y0: 0.3, x1: 0.3, y1: 0.86, thick: 0.018, taper: 0.82, bow: 0.03 },
      { k: 'seg', x0: 0.42, y0: 0.26, x1: 0.38, y1: 0.9, thick: 0.018, taper: 0.82, bow: 0.02 },
      { k: 'seg', x0: 0.48, y0: 0.24, x1: 0.46, y1: 0.93, thick: 0.018, taper: 0.82, bow: 0.01 },
      { k: 'seg', x0: 0.54, y0: 0.24, x1: 0.56, y1: 0.93, thick: 0.018, taper: 0.82, bow: -0.01 },
      { k: 'seg', x0: 0.6, y0: 0.26, x1: 0.64, y1: 0.9, thick: 0.018, taper: 0.82, bow: -0.02 },
      { k: 'seg', x0: 0.66, y0: 0.3, x1: 0.7, y1: 0.84, thick: 0.017, taper: 0.82, bow: -0.03 },
      { k: 'seg', x0: 0.52, y0: 0.32, x1: 0.52, y1: 0.78, thick: 0.017, taper: 0.82, bow: 0.01 },
      // 丝上点叶：让垂下来的部分是「带叶的柳丝」，不是光杆
      { k: 'arc', xa: 0.3, xb: 0.42, base: 0.54, baseVar: 0.04, rise: 0.02, thick: 0.06, spindle: 0.3, px: 0.5 },
      { k: 'arc', xa: 0.44, xb: 0.56, base: 0.58, baseVar: 0.04, rise: 0.02, thick: 0.06, spindle: 0.3, px: 0.5 },
      { k: 'arc', xa: 0.58, xb: 0.7, base: 0.54, baseVar: 0.04, rise: 0.02, thick: 0.06, spindle: 0.3, px: 0.5 },
      { k: 'arc', xa: 0.36, xb: 0.48, base: 0.7, baseVar: 0.04, rise: 0.02, thick: 0.05, spindle: 0.3, px: 0.5 },
      { k: 'arc', xa: 0.54, xb: 0.66, base: 0.7, baseVar: 0.04, rise: 0.02, thick: 0.05, spindle: 0.3, px: 0.5 },
    ],
  },
  {
    id: 'mid-pavilion', group: 1, name: '亭', w: 174, h: 178, seed: 1111,
    parts: [
      { k: 'arc', xa: 0.02, xb: 0.98, base: 0.32, rise: 0.26, thick: 0.105, taper: 0.42, px: 0.5 },
      { k: 'arc', xa: 0.1, xb: 0.9, base: 0.42, rise: 0.03, thick: 0.048, taper: 0.22, px: 0.5 },
      { k: 'seg', x0: 0.22, y0: 0.44, x1: 0.22, y1: 0.92, thick: 0.04, taper: 0.18 },
      { k: 'seg', x0: 0.78, y0: 0.44, x1: 0.78, y1: 0.92, thick: 0.04, taper: 0.18 },
      { k: 'seg', x0: 0.12, y0: 0.95, x1: 0.88, y1: 0.95, thick: 0.032, taper: 0.18 },
    ],
  },

  /* ---------------- 点缀（group 2）---------------- */
  {
    id: 'near-hut', group: 2, name: '茅屋', w: 240, h: 122, seed: 1115,
    parts: [
      // 三角顶 + 两柱 + 门 + 地线。屋顶两笔各是半边，中间留一道脊。
      { k: 'seg', x0: 0.04, y0: 0.54, x1: 0.5, y1: 0.22, thick: 0.065, taper: 0.25 },
      { k: 'seg', x0: 0.96, y0: 0.54, x1: 0.5, y1: 0.22, thick: 0.065, taper: 0.25 },
      { k: 'seg', x0: 0.5, y0: 0.22, x1: 0.5, y1: 0.14, thick: 0.04, taper: 0.4 },
      { k: 'arc', xa: 0.06, xb: 0.94, base: 0.57, rise: 0.02, thick: 0.04, taper: 0.2 },
      { k: 'seg', x0: 0.16, y0: 0.58, x1: 0.16, y1: 0.94, thick: 0.05, taper: 0.2 },
      { k: 'seg', x0: 0.84, y0: 0.58, x1: 0.84, y1: 0.94, thick: 0.05, taper: 0.2 },
      { k: 'seg', x0: 0.1, y0: 0.96, x1: 0.9, y1: 0.96, thick: 0.038, taper: 0.18 },
      { k: 'arc', xa: 0.4, xb: 0.62, base: 0.88, rise: 0.02, thick: 0.16, spindle: 0.35, px: 0.5 },
    ],
  },
  {
    id: 'near-trellis', group: 2, name: '花架', w: 196, h: 166, seed: 1116,
    parts: [
      { k: 'seg', x0: 0.22, y0: 0.26, x1: 0.2, y1: 0.96, thick: 0.042, taper: 0.2 },
      { k: 'seg', x0: 0.78, y0: 0.24, x1: 0.8, y1: 0.96, thick: 0.042, taper: 0.2 },
      { k: 'arc', xa: 0.12, xb: 0.88, base: 0.32, rise: 0.02, thick: 0.036, taper: 0.15 },
      { k: 'arc', xa: 0.14, xb: 0.86, base: 0.58, rise: 0.02, thick: 0.032, taper: 0.15 },
      { k: 'seg', x0: 0.22, y0: 0.34, x1: 0.78, y1: 0.56, thick: 0.016, taper: 0.3 },
      { k: 'seg', x0: 0.78, y0: 0.34, x1: 0.22, y1: 0.56, thick: 0.016, taper: 0.3 },
      // 藤蔓点叶压在顶栏上，不许悬空（悬空像两只帽子）
      { k: 'arc', xa: 0.24, xb: 0.42, base: 0.26, baseVar: 0.05, rise: 0.02, thick: 0.1, spindle: 0.3, px: 0.5 },
      { k: 'arc', xa: 0.58, xb: 0.78, base: 0.22, baseVar: 0.05, rise: 0.02, thick: 0.09, spindle: 0.3, px: 0.5 },
      { k: 'arc', xa: 0.5, xb: 0.7, base: 0.38, baseVar: 0.05, rise: 0.02, thick: 0.08, spindle: 0.3, px: 0.5 },
    ],
  },
  {
    id: 'near-moss', group: 2, name: '苔点', w: 86, h: 78, seed: 1109,
    parts: [
      { k: 'arc', xa: 0.08, xb: 0.4, base: 0.28, baseVar: 0.1, rise: 0.05, thick: 0.3, spindle: 0.34, px: 0.42 },
      { k: 'arc', xa: 0.42, xb: 0.82, base: 0.52, baseVar: 0.1, rise: 0.05, thick: 0.34, spindle: 0.3, px: 0.58 },
      { k: 'arc', xa: 0.04, xb: 0.34, base: 0.78, baseVar: 0.1, rise: 0.05, thick: 0.27, spindle: 0.38, px: 0.46 },
    ],
  },
  {
    id: 'near-tea', group: 2, name: '煎茶', w: 116, h: 105, seed: 1117,
    parts: [
      { k: 'arc', xa: 0.3, xb: 0.46, base: 0.16, baseVar: 0.02, rise: 0.02, thick: 0.15, spindle: 0.45, px: 0.5 },
      { k: 'seg', x0: 0.38, y0: 0.26, x1: 0.34, y1: 0.56, thick: 0.08, taper: 0.15 },
      { k: 'seg', x0: 0.34, y0: 0.56, x1: 0.24, y1: 0.8, thick: 0.062, taper: 0.35 },
      { k: 'seg', x0: 0.34, y0: 0.56, x1: 0.44, y1: 0.8, thick: 0.062, taper: 0.35 },
      { k: 'seg', x0: 0.36, y0: 0.36, x1: 0.6, y1: 0.46, thick: 0.03, taper: 0.45 },
      { k: 'arc', xa: 0.62, xb: 0.84, base: 0.72, baseVar: 0.02, rise: 0.03, thick: 0.18, spindle: 0.3, px: 0.5 },
      { k: 'arc', xa: 0.64, xb: 0.82, base: 0.58, baseVar: 0.02, rise: 0.02, thick: 0.12, spindle: 0.35, px: 0.5 },
      { k: 'arc', xa: 0.66, xb: 0.8, base: 0.42, rise: 0.14, thick: 0.022, taper: 0.5 },
    ],
  },
  {
    id: 'near-cup', group: 2, name: '洗盏', w: 100, h: 95, seed: 1118,
    parts: [
      { k: 'arc', xa: 0.26, xb: 0.4, base: 0.16, baseVar: 0.02, rise: 0.02, thick: 0.16, spindle: 0.45, px: 0.5 },
      { k: 'seg', x0: 0.34, y0: 0.26, x1: 0.3, y1: 0.56, thick: 0.085, taper: 0.15 },
      { k: 'seg', x0: 0.3, y0: 0.56, x1: 0.2, y1: 0.8, thick: 0.065, taper: 0.35 },
      { k: 'seg', x0: 0.3, y0: 0.56, x1: 0.4, y1: 0.8, thick: 0.065, taper: 0.35 },
      { k: 'seg', x0: 0.32, y0: 0.38, x1: 0.56, y1: 0.58, thick: 0.03, taper: 0.45 },
      { k: 'arc', xa: 0.52, xb: 0.8, base: 0.74, baseVar: 0.02, rise: 0.05, thick: 0.15, spindle: 0.3, px: 0.5 },
      { k: 'arc', xa: 0.56, xb: 0.76, base: 0.68, rise: 0.02, thick: 0.03, taper: 0.3 },
    ],
  },
  {
    id: 'near-kneel', group: 2, name: '抱膝', w: 104, h: 99, seed: 1119,
    parts: [
      // 侧身抱膝：头 + 上身 + 平起的膝 + 小腿 + 抱膝的手臂 + 坐地线
      { k: 'arc', xa: 0.36, xb: 0.5, base: 0.2, baseVar: 0.02, rise: 0.02, thick: 0.15, spindle: 0.45, px: 0.5 },
      { k: 'seg', x0: 0.44, y0: 0.3, x1: 0.42, y1: 0.58, thick: 0.09, taper: 0.2 },
      { k: 'seg', x0: 0.42, y0: 0.56, x1: 0.24, y1: 0.63, thick: 0.08, taper: 0.3 },
      { k: 'seg', x0: 0.24, y0: 0.63, x1: 0.22, y1: 0.82, thick: 0.06, taper: 0.3 },
      { k: 'seg', x0: 0.44, y0: 0.4, x1: 0.28, y1: 0.63, thick: 0.028, taper: 0.45 },
      { k: 'arc', xa: 0.16, xb: 0.56, base: 0.86, rise: 0.02, thick: 0.04, taper: 0.2 },
    ],
  },
  {
    id: 'near-herb', group: 2, name: '洗药', w: 118, h: 106, seed: 1120,
    parts: [
      { k: 'arc', xa: 0.24, xb: 0.38, base: 0.18, baseVar: 0.02, rise: 0.02, thick: 0.15, spindle: 0.45, px: 0.5 },
      { k: 'seg', x0: 0.32, y0: 0.28, x1: 0.26, y1: 0.52, thick: 0.082, taper: 0.15 },
      { k: 'seg', x0: 0.26, y0: 0.52, x1: 0.18, y1: 0.76, thick: 0.062, taper: 0.35 },
      { k: 'seg', x0: 0.26, y0: 0.52, x1: 0.36, y1: 0.76, thick: 0.062, taper: 0.35 },
      { k: 'seg', x0: 0.3, y0: 0.36, x1: 0.58, y1: 0.58, thick: 0.028, taper: 0.45 },
      { k: 'arc', xa: 0.54, xb: 0.76, base: 0.7, baseVar: 0.02, rise: 0.06, thick: 0.15, spindle: 0.3, px: 0.5 },
      { k: 'arc', xa: 0.56, xb: 0.66, base: 0.62, baseVar: 0.02, rise: 0.02, thick: 0.07, spindle: 0.3, px: 0.5 },
      { k: 'arc', xa: 0.68, xb: 0.76, base: 0.6, baseVar: 0.02, rise: 0.02, thick: 0.06, spindle: 0.3, px: 0.5 },
    ],
  },
  {
    id: 'near-fish', group: 2, name: '垂钓', w: 198, h: 103, seed: 1121,
    parts: [
      { k: 'arc', xa: 0.18, xb: 0.28, base: 0.18, baseVar: 0.02, rise: 0.02, thick: 0.155, spindle: 0.45, px: 0.5 },
      { k: 'seg', x0: 0.23, y0: 0.28, x1: 0.2, y1: 0.56, thick: 0.075, taper: 0.15 },
      { k: 'seg', x0: 0.2, y0: 0.56, x1: 0.12, y1: 0.8, thick: 0.06, taper: 0.35 },
      { k: 'seg', x0: 0.2, y0: 0.56, x1: 0.28, y1: 0.8, thick: 0.06, taper: 0.35 },
      { k: 'seg', x0: 0.22, y0: 0.34, x1: 0.5, y1: 0.2, thick: 0.028, taper: 0.45 },
      { k: 'seg', x0: 0.5, y0: 0.2, x1: 0.88, y1: 0.1, thick: 0.018, taper: 0.4 },
      { k: 'seg', x0: 0.88, y0: 0.1, x1: 0.875, y1: 0.6, thick: 0.009, taper: 0.1 },
      { k: 'arc', xa: 0.7, xb: 0.98, base: 0.72, rise: 0.04, thick: 0.035, taper: 0.3 },
      { k: 'arc', xa: 0.04, xb: 0.4, base: 0.88, rise: 0.03, thick: 0.04, taper: 0.3 },
    ],
  },
  {
    id: 'near-net', group: 2, name: '扳罾', w: 176, h: 164, seed: 1122,
    parts: [
      { k: 'arc', xa: 0.26, xb: 0.38, base: 0.14, baseVar: 0.02, rise: 0.02, thick: 0.15, spindle: 0.45, px: 0.5 },
      { k: 'seg', x0: 0.32, y0: 0.24, x1: 0.28, y1: 0.46, thick: 0.085, taper: 0.15 },
      { k: 'seg', x0: 0.28, y0: 0.46, x1: 0.2, y1: 0.62, thick: 0.065, taper: 0.35 },
      { k: 'seg', x0: 0.28, y0: 0.46, x1: 0.36, y1: 0.62, thick: 0.065, taper: 0.35 },
      { k: 'seg', x0: 0.32, y0: 0.3, x1: 0.52, y1: 0.2, thick: 0.028, taper: 0.4 },
      { k: 'seg', x0: 0.52, y0: 0.18, x1: 0.86, y1: 0.3, thick: 0.02, taper: 0.3 },
      { k: 'arc', xa: 0.62, xb: 0.98, base: 0.46, rise: 0.22, thick: 0.045, taper: 0.5 },
      { k: 'arc', xa: 0.6, xb: 0.96, base: 0.56, rise: 0.3, thick: 0.04, taper: 0.5 },
      { k: 'seg', x0: 0.66, y0: 0.34, x1: 0.92, y1: 0.46, thick: 0.012, taper: 0.2 },
      { k: 'seg', x0: 0.64, y0: 0.42, x1: 0.94, y1: 0.52, thick: 0.012, taper: 0.2 },
      { k: 'arc', xa: 0.04, xb: 0.5, base: 0.8, rise: 0.03, thick: 0.045, taper: 0.3 },
    ],
  },
];

/* 对外常量：托盘只认这三个字段（§5）。地理数据留在 SPECS 里，不外泄。 */
export const PIECES = Object.freeze(
  SPECS.map((s) => Object.freeze({ id: s.id, group: s.group, name: s.name })),
);

const SPEC_BY_ID = new Map(SPECS.map((s) => [s.id, s]));

/* =====================================================================
 * §4 预渲染：一块墨 × 5 色
 *   一块墨 = 一组笔画；每一遍都对**每一条**重描。
 *   遍数结构（层权 1/2, 1/4, …, 1/128，层内再拆 ≤8% 台阶的小遍）：
 *     1) 湿晕    —— 墨在纸纤维里洇开，圆盘内随机偏移，越远越淡
 *     2) 主体    —— 7 层边缘衰减，这是「边缘衰减」的主体
 *     3) 骨      —— 一遍收紧的芯（没有它，多层低 alpha 叠不出墨，只会糊成灰）
 *     4) 飞白    —— destination-out 沿笔画切向擦出丝状白缝（墨越浓越显）
 *   全程没有 ctx.filter / blur（见文件头注释 #1）。
 * ===================================================================== */

const BAKE = Object.freeze({
  inset: 0.62,        // 几何只用画布中间这片 ⇒ 四周留白，湿晕不会被画布边缘裁成直角
  insetSoft: 0.46,    // 软块（雾）洇得远，内缩要更多
  edgeLayers: 7,      // 「6~8 层低透明度叠加」：这里取 7 层
  edgeMaxStep: 0.085, // 层内单遍 alpha 上限（低于肉眼可见台阶）
  wetPasses: 10,      // 湿晕遍数
  wetPassesSoft: 8,
  radiusProfile: [0.006, 0.011, 0.018, 0.027, 0.038, 0.05, 0.064], // 每层的外扩半径（×base）
  density: 0.94,      // 主体总浓度（软块另算）
  densitySoft: 0.52,
  boneInk: 0.2,       // 骨 = boneInk + bonePerInk * canonInk
  bonePerInk: 0.45,
  canonInk: 0.7,      // 纹理按这一档墨色烘一次；落位时再用 globalAlpha 调墨色
  flyBase: 0.8,       // 飞白条数 = flyBase + flyPerInk * canonInk
  flyPerInk: 4.6,
});

const TEX_EDGE_LAYER_WEIGHTS = (() => {
  const raw = [];
  for (let k = 0; k < BAKE.edgeLayers; k++) raw.push(Math.pow(0.5, k + 1)); // 1/2,1/4,1/8…
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => w / sum); // 归一 ⇒ Σ 权重 = 1
})();

/* 每一遍都重新抖动：每遍有独立位移/宽度扰动 ⇒ 边缘自然毛，不是整体平移。
 * 这里刻意不用 ctx.filter 的 blur：Chromium 给带滤镜的绘制开的临时层按路径
 * 包围盒裁，模糊本该洇到包围盒外的部分被切掉，纸上就多出一圈矩形硬边。
 * 「软」只能靠多遍小幅随机偏移叠加 = 按圆盘核做扩散，边缘永远是衰减的。 */
function jitterShape(shape, rnd, jitter) {
  const n = shape.pts.length;
  const pts = new Array(n);
  const widths = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = shape.pts[i];
    pts[i] = {
      x: p.x + (jitter ? (rnd() - 0.5) * jitter : 0),
      y: p.y + (jitter ? (rnd() - 0.5) * jitter : 0),
    };
    widths[i] = Math.max(0.8, shape.widths[i] * (1 + (rnd() - 0.5) * 0.12));
  }
  return { pts, widths };
}

/**
 * 预渲染一张纹理：spec × hueIndex，尺寸 spec.w × spec.h（乘 texDpr）。
 * 返回的 canvas 背景透明，只有这一块墨的 alpha。
 * 确定性：同一 spec + 同一 seed ⇒ 无论第几张、什么色相，形状逐像素一致。
 */
function bakeTexture(spec, hueIndex, texDpr) {
  const hue = HUES[hueIndex] || HUES[0];
  const cw = Math.max(1, Math.round(spec.w * texDpr));
  const ch = Math.max(1, Math.round(spec.h * texDpr));
  const cv = document.createElement('canvas');
  cv.width = cw;
  cv.height = ch;
  const ctx = cv.getContext('2d');

  const inset = spec.soft ? BAKE.insetSoft : BAKE.inset;
  const iw = spec.w * inset; // 逻辑几何区宽
  const ih = spec.h * inset;
  const mx = (spec.w - iw) / 2;
  const my = (spec.h - ih) / 2;
  const base = Math.max(iw, ih);
  const minDim = Math.min(iw, ih);
  const margin = Math.min(mx, my);
  const limit = Math.max(1, margin * 0.92); // 抖动半径上限：不许顶到画布边缘（否则又是硬边）

  ctx.scale(texDpr, texDpr);
  ctx.translate(mx, my);

  // 固定种子 ⇒ 同一块墨的形状、每一遍的抖动、飞白位置全部可复现。
  const rnd = mulberry32(spec.seed * 7 + 13);
  const mains = spec.parts.map((p) =>
    p.k === 'seg' ? buildSeg(rnd, iw, ih, base, p) : buildArc(rnd, iw, ih, p),
  );

  const wetJitter = Math.min(base * 0.01, minDim * 0.05);
  const bodyJitter = Math.min(base * 0.009, minDim * 0.035);
  const boneJitter = Math.min(base * 0.005, minDim * 0.02);

  const fill = (alpha, jitter, dx, dy) => {
    if (!(alpha > 0)) return;
    ctx.save();
    ctx.globalAlpha = Math.min(1, alpha * hue.f); // 色相重量补偿只乘在这一处
    ctx.fillStyle = hue.css;
    for (const m of mains) {
      const sh = jitterShape(m, rnd, jitter);
      sh.pts.forEach((p) => {
        p.x += dx || 0;
        p.y += dy || 0;
      });
      traceShape(ctx, sh);
    }
    ctx.restore();
  };

  /* 1) 湿晕：墨往纸纤维里洇出去的那一圈。半径比主体大一个量级，单遍 alpha 极低。 */
  const wetPasses = spec.soft ? BAKE.wetPassesSoft : BAKE.wetPasses;
  const wetRadius = Math.min(base * (spec.soft ? 0.2 : 0.055), limit);
  const wetAlpha = spec.soft ? 0.0026 : 0.0042;
  for (let k = 0; k < wetPasses; k++) {
    const ang = rnd() * Math.PI * 2;
    const rad = wetRadius * Math.sqrt(rnd()); // 圆盘内均匀 ⇒ 边缘包络 1-(d/R)²
    fill(wetAlpha * (0.75 + rnd() * 0.5), wetJitter, Math.cos(ang) * rad, Math.sin(ang) * rad);
  }

  /* 2) 主体：7 层边缘衰减，层权 1/2,1/4,1/8,…,1/128。
   *    层内按「单遍 ≤8.5%」拆成若干遍（遍数越多、台阶越低），
   *    每遍用各自独立的随机位移 —— 总浓度不变、切得更碎。 */
  const density = spec.soft ? BAKE.densitySoft : BAKE.density;
  const radiusScale = spec.soft ? 1.9 : 1;
  for (let k = 0; k < BAKE.edgeLayers; k++) {
    const target = density * TEX_EDGE_LAYER_WEIGHTS[k]; // 这一层的总不透明度
    const subs = Math.max(1, Math.ceil(target / BAKE.edgeMaxStep));
    const each = 1 - Math.pow(1 - target, 1 / subs); // 叠 subs 遍 ⇒ 该层总浓度 = target
    const radius = Math.min(base * BAKE.radiusProfile[k] * radiusScale, limit);
    for (let s = 0; s < subs; s++) {
      const ang = rnd() * Math.PI * 2;
      const rad = radius * Math.sqrt(rnd());
      fill(each, bodyJitter, Math.cos(ang) * rad, Math.sin(ang) * rad);
    }
  }

  /* 3) 骨：收紧的芯。没有它，多层低 alpha 叠不出墨，只会糊成灰。
   *    雾不给骨 —— 一根硬芯会把烟变成灰面包。 */
  if (!spec.soft) {
    const boneAlpha = BAKE.boneInk + BAKE.bonePerInk * BAKE.canonInk;
    const ang = rnd() * Math.PI * 2;
    const rad = boneJitter * Math.sqrt(rnd());
    fill(boneAlpha, boneJitter, Math.cos(ang) * rad, Math.sin(ang) * rad);
  }

  /* 4) 飞白：沿笔身擦出断续细缝（雾是虚的，飞白要少）。
   *    方向必须是「墨越浓越飞白」——淡墨含水多、笔迹匀，几乎不破笔；
   *    浓墨稠，笔毛一分才露纸。预渲染按 canonical 墨色烘，落位时再乘
   *    globalAlpha（墨色）：整体越浓 ⇒ 白缝越显，方向与强弱都随墨色单调。
   *    落脚按笔画长度加权 —— 平分的话，一颗苔点会和整条树干拿到同样多的裂缝。
   *    缝要**短**（3~10 个采样点）并带一点横向正弦摆：太长太直就成了铅笔划痕，
   *    不是笔毛分岔（目检 pieces-19-sheet.png 第一版就是这个毛病）。 */
  const flyCount = Math.round((BAKE.flyBase + BAKE.flyPerInk * BAKE.canonInk) * (spec.soft ? 0.4 : 1));
  if (!spec.soft && flyCount > 0) {
    const lens = mains.map((m) => {
      let s = 0;
      for (let i = 1; i < m.pts.length; i++) {
        s += Math.hypot(m.pts[i].x - m.pts[i - 1].x, m.pts[i].y - m.pts[i - 1].y);
      }
      return s;
    });
    const totalLen = lens.reduce((a, b) => a + b, 0) || 1;
    const pickMain = () => {
      let r = rnd() * totalLen;
      for (let i = 0; i < lens.length; i++) {
        r -= lens[i];
        if (r <= 0) return mains[i];
      }
      return mains[mains.length - 1];
    };
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = '#000';
    ctx.lineCap = 'round';
    for (let k = 0; k < flyCount; k++) {
      const main = pickMain();
      const s0 = Math.floor(rnd() * (NPT - 10));
      const s1 = s0 + 3 + Math.floor(rnd() * 8);
      const off = (rnd() - 0.5) * main.widths[s0] * 0.72;
      ctx.globalAlpha = (0.04 + (0.1 + 0.26 * rnd()) * BAKE.canonInk) * 0.85;
      ctx.lineWidth = base * (0.0025 + rnd() * 0.008);
      ctx.beginPath();
      for (let i = s0; i <= Math.min(s1, NPT - 1); i++) {
        const p = main.pts[i];
        const a = main.pts[Math.max(0, i - 1)];
        const b = main.pts[Math.min(NPT - 1, i + 1)];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const l = Math.hypot(dx, dy) || 1;
        dx /= l;
        dy /= l;
        // 沿切线走、向法线偏一点 ⇒ 白缝顺着笔势，不是横切笔画；
        // sway 的频率必须低（每 ~11 个采样点一个来回），否则相邻取点相位差 180°
        // 会连成锯齿 —— 目检第一版就出过一道折线划痕。
        const sway = Math.sin((i - s0) * 0.55) * main.widths[i] * 0.08;
        const x = p.x - dy * (off + sway);
        const y = p.y + dx * (off + sway);
        if (i === s0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  return cv;
}

/* =====================================================================
 * §5 纸：800×560 逻辑尺寸，宣纸底色 + 程序化纤维噪声
 *   离屏生成一次，三张共用（同构）。同样不用 blur：地平线与水痕都用
 *   「同一形状多遍微偏移叠加」做包络衰减。
 * ===================================================================== */

function bakePaper(w, h, dpr) {
  const c = document.createElement('canvas');
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const x = c.getContext('2d');
  x.scale(dpr, dpr);
  x.fillStyle = PAPER_TONE;
  x.fillRect(0, 0, w, h);

  /* 纤维噪点 */
  const rnd = mulberry32(20261010);
  const fibers = Math.round(5200 * ((w * h) / (LOGICAL.width * LOGICAL.height)));
  for (let i = 0; i < fibers; i++) {
    x.globalAlpha = 0.018 + rnd() * 0.026;
    x.fillStyle = rnd() < 0.52 ? '#8a8375' : '#ffffff';
    x.beginPath();
    x.arc(rnd() * w, rnd() * h, 0.35 + rnd() * 1.6, 0, Math.PI * 2);
    x.fill();
  }
  x.globalAlpha = 1;

  /* 极淡的地平线暗示：给「上下」一个极轻的参考，不是画面元素。
   * 横贯全宽的路径 + blur 会留下上下两条水平硬边（当初「像横格纸线」的来源），
   * 所以改成同一形状在 y 上多次微偏移叠加，包络自然衰减。 */
  const gRound = mulberry32(4242);
  x.save();
  x.fillStyle = INK_BLACK;
  for (let k = 0; k < 12; k++) {
    const dy = (gRound() - 0.5) * (w * 0.07);
    x.globalAlpha = 0.0013;
    x.beginPath();
    x.moveTo(-w * 0.05, h * 0.66 + dy);
    for (let i = 0; i <= 30; i++) {
      const t = i / 30;
      x.lineTo(
        w * t,
        h * (0.66 - 0.03 * Math.sin(t * Math.PI * 1.2 + 0.7) - 0.01 * Math.sin(t * 11.3)) + dy,
      );
    }
    x.lineTo(w * 1.05, h * 0.75 + dy);
    x.lineTo(-w * 0.05, h * 0.75 + dy);
    x.closePath();
    x.fill();
  }
  x.restore();

  /* 两三道断续的极淡水痕：刻意不等距、不平行。
   * 必须是**真的断续**：连续贝塞尔描边落到纸上是三根有头有尾的直线，
   * 眼神一扫会把它们连成一个框（墨心真的被这个坑过一次：空纸上的淡矩形）。
   * 所以沿路径切成一节一节，节间留随机空档，每节 alpha 走「两头 0、中间最浓」
   * 的包络 —— 没有端点，就认不出「这是条线」。 */
  x.save();
  x.strokeStyle = INK_BLACK;
  x.lineCap = 'round';
  const rnd2 = mulberry32(777);
  for (let k = 0; k < 3; k++) {
    const y0 = h * (0.735 + k * 0.042 + rnd2() * 0.02);
    const xa = w * (0.06 + rnd2() * 0.22);
    const xb = xa + w * (0.2 + rnd2() * 0.34);
    const peak = 0.016 + rnd2() * 0.014;
    const c1x = xa + (xb - xa) * 0.35;
    const c2x = xa + (xb - xa) * 0.68;
    const c1y = y0 - 2.4;
    const c2y = y0 + 2.6;
    const e = (t) => 1 - t;
    const bx = (t) => e(t) ** 3 * xa + 3 * e(t) ** 2 * t * c1x + 3 * e(t) * t * t * c2x + t ** 3 * xb;
    const by = (t) =>
      e(t) ** 3 * y0 + 3 * e(t) ** 2 * t * c1y + 3 * e(t) * t * t * c2y + t ** 3 * (y0 - 0.6);
    let t = 0;
    while (t < 1) {
      const t1 = Math.min(1, t + 0.02 + rnd2() * 0.05);
      const env = Math.sin(Math.PI * ((t + t1) / 2)); // 两头 0、中间 1 的包络
      x.globalAlpha = peak * env * (0.55 + rnd2() * 0.45);
      x.lineWidth = 0.9 + rnd2() * 1.1;
      x.beginPath();
      x.moveTo(bx(t), by(t));
      for (let s = 0.2; s <= 1.0001; s += 0.2) x.lineTo(bx(t + (t1 - t) * s), by(t + (t1 - t) * s));
      x.stroke();
      t = t1 + 0.01 + rnd2() * 0.06; // 空档
    }
  }
  x.restore();
  return c;
}

/* =====================================================================
 * §6 小工具
 * ===================================================================== */

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v) {
  return clamp(v, 0, 1);
}
function roundTo(v, digits) {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}
function mean(list) {
  if (!list.length) return 0;
  let s = 0;
  for (const v of list) s += v;
  return s / list.length;
}
function stdev(list) {
  if (list.length < 2) return 0;
  const m = mean(list);
  let s = 0;
  for (const v of list) s += (v - m) * (v - m);
  return Math.sqrt(s / list.length);
}

/* 墨色 → 落位时的整体不透明度（唯一一处把滑杆数字变成像素的地方）。
 * 纹理按 canonInk=0.7 烘好，这里只做整体调制：
 *   淡墨仍要看得见（0.30 底），浓墨接近实底（1.0）。
 * 白缝（飞白）的绝对强度也跟着这条曲线单调递增 ⇒ 「墨越浓越飞白」。 */
function inkAlpha(ink) {
  const v = clamp01(num(ink, DEFAULT_INK));
  return 0.3 + 0.7 * Math.pow(v, 0.85);
}

/* =====================================================================
 * §7 工厂：createBoard(rootEl, opts)
 *   状态全部在闭包里；对外只暴露契约 §5 的方法。
 * ===================================================================== */

export function createBoard(rootEl, opts = {}) {
  if (!rootEl) throw new Error('ink.createBoard: 缺少挂载点 rootEl');

  const W = Math.max(160, Math.round(num(opts.width, LOGICAL.width)));
  const H = Math.max(120, Math.round(num(opts.height, LOGICAL.height)));
  const dpr = clamp(num(opts.dpr, DEFAULT_DPR), 1, 3);
  const reducedMotion =
    opts.reducedMotion != null
      ? !!opts.reducedMotion
      : typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const piecesPerRound = clamp(
    Math.round(num(opts.piecesPerRound, PIECES.length)),
    3,
    PIECES.length,
  );
  const offeredIds = new Set(PIECES.slice(0, piecesPerRound).map((p) => p.id));

  /* ---------- 运行时状态 ---------- */
  let mounted = false;
  let canvas = null;
  let ctx = null;
  let paperTex = null;
  let metricCanvas = null;
  let texDpr = Math.min(dpr, 2);
  const textures = new Map(); // `${pieceId}#${hue}` -> canvas

  let round = 1;
  let stamps = []; // 落墨记录（按落墨顺序，同时是 z 序）
  const settings = { ink: DEFAULT_INK, scale: DEFAULT_SCALE, hue: 0, rot: 0 };
  let hand = null; // 从托盘取起、还没落纸的那块（pieceId）
  let sel = null; // 正在被滑杆调的那一笔（stamp 引用；落墨后仍留着）
  let drag = null; // { stamp, dx, dy, mode:'place'|'move', moved }
  let pointer = { x: 0.5, y: 0.5 }; // 最近一次指针在纸上的相对位置（ghost 用）
  let animStamp = null;
  let animStart = 0;
  let fading = false;
  let rafId = 0;

  let undoCount = 0;
  let repositionCount = 0;
  let firstPickAt = null;
  let firstPlaceAt = null;
  let firstPlaceMs = 0;
  let activity = []; // 动手时间戳（active_ms 用）

  let pixelRev = 0; // 任何影响像素/读数的变化都 +1
  let statsCache = null; // { rev, value } —— stats() 只在必要时 getImageData
  const listeners = [];

  const now = () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

  function touchActivity() {
    activity.push(now());
    if (activity.length > 4096) activity = activity.slice(-2048);
  }

  function emit(type, extra) {
    if (!listeners.length) return;
    const payload = {
      type,
      round,
      pieces: stamps.length,
      selected: sel
        ? { pieceId: sel.pieceId, x: sel.x, y: sel.y, scale: sel.scale, ink: sel.ink, hue: sel.hue, rot: sel.rot }
        : null,
      hand,
      settings: { ink: settings.ink, scale: settings.scale, hue: settings.hue, rot: settings.rot },
      stats: null,
    };
    if (extra) Object.assign(payload, extra);
    for (const cb of listeners.slice()) {
      try {
        cb(payload);
      } catch (err) {
        /* 回调是别人的代码，不许拖垮渲染 */
        if (typeof console !== 'undefined' && console.error) console.error('[ink] change 回调异常', err);
      }
    }
  }

  /* ---------- 纹理预渲染（只在 mount 跑一次） ---------- */

  function textureKey(pieceId, hue) {
    return pieceId + '#' + hue;
  }

  function getTexture(st) {
    return textures.get(textureKey(st.pieceId, st.hue)) || null;
  }

  function bakeAllTextures() {
    textures.clear();
    for (const spec of SPECS) {
      for (let h = 0; h < HUES.length; h++) {
        textures.set(textureKey(spec.id, h), bakeTexture(spec, h, texDpr));
      }
    }
  }

  /* 纹理分辨率跟着「屏幕上一个逻辑像素实际占多少设备像素」走：
   * 手机上纸面缩到 ~343px 宽，纹理烘到 2× 是纯浪费（还占内存、拖慢 mount）。
   * 桌面大屏才需要 2×。上限仍是 dpr（契约默认 2）。 */
  function pickTextureDpr() {
    let cssW = 0;
    if (rootEl && typeof rootEl.getBoundingClientRect === 'function') {
      cssW = rootEl.getBoundingClientRect().width || 0;
    }
    if (!cssW && typeof window !== 'undefined') cssW = window.innerWidth || 0;
    if (!cssW) return Math.min(dpr, 2);
    const screenDpr =
      typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
    const devicePerLogical = (cssW / W) * screenDpr;
    return clamp(Math.min(dpr, devicePerLogical), 1, dpr);
  }

  /* ---------- 画 ---------- */

  function drawStamp(target, st, mul) {
    const tex = getTexture(st);
    if (!tex) return;
    target.save();
    target.globalAlpha = clamp01(inkAlpha(st.ink) * (mul == null ? 1 : mul));
    target.translate(st.x * W, st.y * H);
    target.rotate((st.rot * Math.PI) / 180);
    const dw = st.spec.w * st.scale;
    const dh = st.spec.h * st.scale;
    target.drawImage(tex, -dw / 2, -dh / 2, dw, dh);
    target.restore();
  }

  function fadeMul(t) {
    if (!fading || !animStamp || !(FADE_MS > 0)) return 1;
    const p = clamp01((t - animStart) / FADE_MS);
    const e = 1 - Math.pow(1 - p, 3); // easeOutCubic
    return FADE_START + (1 - FADE_START) * e;
  }

  function drawSelection() {
    if (!sel) return;
    const spec = sel.spec;
    const k = sel.scale;
    ctx.save();
    ctx.translate(sel.x * W, sel.y * H);
    ctx.rotate((sel.rot * Math.PI) / 180);
    ctx.globalAlpha = 1;
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(61,74,58,.5)';
    ctx.lineWidth = 1.1;
    ctx.strokeRect(-(spec.w * k) / 2 - 5, -(spec.h * k) / 2 - 5, spec.w * k + 10, spec.h * k + 10);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -(spec.h * k) / 2 - 14);
    ctx.strokeStyle = 'rgba(61,74,58,.75)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(61,74,58,.75)';
    ctx.fill();
    ctx.restore();
  }

  function drawGhost() {
    const spec = SPEC_BY_ID.get(hand);
    if (!spec) return;
    const ghost = {
      pieceId: spec.id,
      spec,
      x: pointer.x,
      y: pointer.y,
      scale: settings.scale,
      ink: settings.ink,
      hue: settings.hue,
      rot: settings.rot,
    };
    drawStamp(ctx, ghost, 0.42);
    const k = ghost.scale;
    ctx.save();
    ctx.translate(ghost.x * W, ghost.y * H);
    ctx.rotate((ghost.rot * Math.PI) / 180);
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = 'rgba(61,74,58,.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(-(spec.w * k) / 2, -(spec.h * k) / 2, spec.w * k, spec.h * k);
    ctx.restore();
  }

  function renderScene(clean) {
    if (!mounted || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(paperTex, 0, 0, W, H);

    const t = now();
    for (const st of stamps) drawStamp(ctx, st, fadeMul(t));
    if (!clean) {
      drawSelection();
      if (hand) drawGhost();
    }
  }

  function scheduleRender() {
    if (!mounted || rafId) return;
    rafId = requestAnimationFrame(tick);
  }

  function tick() {
    rafId = 0;
    if (fading && now() - animStart >= FADE_MS) {
      fading = false;
      animStamp = null;
    }
    renderScene(false);
    if (fading) scheduleRender();
  }

  /* ---------- 指标（§4）：只有这里 getImageData ---------- */

  function measurePixels() {
    if (!metricCanvas) metricCanvas = document.createElement('canvas');
    if (metricCanvas.width !== W || metricCanvas.height !== H) {
      metricCanvas.width = W;
      metricCanvas.height = H;
    }
    const x = metricCanvas.getContext('2d', { willReadFrequently: true });
    x.clearRect(0, 0, W, H);
    for (const st of stamps) drawStamp(x, st, 1);

    const data = x.getImageData(0, 0, W, H).data; // ← 每次 stats 只读这一下
    const total = W * H;
    let inkPx = 0;
    let wSum = 0;
    let wx = 0;
    let wy = 0;
    for (let p = 0; p < total; p++) {
      const a = data[p * 4 + 3] / 255;
      if (a > INK_PIXEL_ALPHA) inkPx++;
      if (a > WEIGHT_ALPHA) {
        const px = p % W;
        const py = (p / W) | 0;
        wSum += a;
        wx += a * px;
        wy += a * py;
      }
    }
    const cx = wSum ? wx / wSum : W / 2;
    const cy = wSum ? wy / wSum : H / 2;
    const centerBias = Math.hypot(cx - W / 2, cy - H / 2) / Math.hypot(W / 2, H / 2);
    return {
      blankRatio: total ? 1 - inkPx / total : 1, // 整纸留白 0–1
      centerBias: clamp01(centerBias), // 重心偏移 0–1
    };
  }

  function computeActiveMs() {
    if (activity.length < 2) return 0;
    let sum = 0;
    for (let i = 1; i < activity.length; i++) {
      const gap = activity[i] - activity[i - 1];
      if (gap > 0 && gap < ACTIVE_GAP_MS) sum += gap; // 去掉 >10s 的空档（去泡茶时间）
    }
    return Math.round(sum);
  }

  function computeStats() {
    const n = stamps.length;
    const inks = stamps.map((s) => s.ink);
    const scales = stamps.map((s) => s.scale);
    const hueUsed = [0, 0, 0, 0, 0];
    const groups = [];
    for (const st of stamps) {
      hueUsed[clamp(Math.round(st.hue), 0, HUES.length - 1)]++;
      groups.push(st.spec.group);
    }
    let groupSwitches = 0;
    for (let i = 1; i < groups.length; i++) if (groups[i] !== groups[i - 1]) groupSwitches++;

    const px = measurePixels();
    const scaleMin = n ? Math.min.apply(null, scales) : 1;
    const scaleMax = n ? Math.max.apply(null, scales) : 1;

    return {
      /* --- 过程：动作（每一条都对着一个客观动作）--- */
      pieces_used: n, // int  落墨次数（同块可重复，按笔计）
      hue_used: hueUsed, // [int] 长度 5（墨/赭石/花青/藤黄/朱砂）
      undo_count: undoCount, // int
      reposition_count: repositionCount, // int
      first_place_ms: firstPlaceMs, // int  首次取块 → 首次落墨
      active_ms: computeActiveMs(), // int  去掉 >10s 空档后的动手时长
      scale_mean: n ? roundTo(mean(scales), 3) : 1, // float（没动过滑杆 = 1.00）
      scale_range: n ? roundTo(scaleMax - scaleMin, 3) : 0, // float
      groups_used: new Set(groups).size, // int 0–3
      group_switches: groupSwitches, // int
      first_group: n ? groups[0] : null, // int|null 0=远 1=中 2=点
      /* --- 画面：读像素 --- */
      blank_ratio: roundTo(px.blankRatio, 4), // float 0–1
      center_bias: roundTo(px.centerBias, 4), // float 0–1
      /* --- 用墨：滑杆值（真实读数，不是空值）--- */
      ink_mean: n ? roundTo(mean(inks), 3) : 0, // float 0–1
      ink_sd: n > 1 ? roundTo(stdev(inks), 3) : 0, // float
    };
  }

  /* ---------- 交互 ---------- */

  function uv(e) {
    const r = canvas.getBoundingClientRect();
    const x = r.width ? (e.clientX - r.left) / r.width : 0.5;
    const y = r.height ? (e.clientY - r.top) / r.height : 0.5;
    return { x: clamp01(x), y: clamp01(y) };
  }

  function hitTest(ux, uy) {
    for (let i = stamps.length - 1; i >= 0; i--) {
      const st = stamps[i];
      const dx = (ux - st.x) * W;
      const dy = (uy - st.y) * H;
      const a = (-st.rot * Math.PI) / 180;
      const lx = dx * Math.cos(a) - dy * Math.sin(a);
      const ly = dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(lx) <= (st.spec.w * st.scale) / 2 && Math.abs(ly) <= (st.spec.h * st.scale) / 2) {
        return st;
      }
    }
    return null;
  }

  function placeAt(u) {
    const spec = SPEC_BY_ID.get(hand);
    if (!spec) return;
    const st = {
      pieceId: spec.id,
      spec,
      x: clamp01(u.x),
      y: clamp01(u.y),
      scale: settings.scale,
      ink: settings.ink,
      hue: settings.hue,
      rot: settings.rot,
    };
    stamps.push(st);
    sel = st;
    hand = null;
    if (firstPlaceAt == null) {
      firstPlaceAt = now();
      firstPlaceMs =
        firstPickAt == null ? 0 : Math.max(0, Math.round(firstPlaceAt - firstPickAt));
    }
    touchActivity();
    pixelRev++;
    statsCache = null;
    if (!reducedMotion) {
      animStamp = st;
      animStart = now();
      fading = true;
    }
    drag = { stamp: st, dx: 0, dy: 0, mode: 'place', moved: false };
    emit('change', { action: 'place', piece: spec.id });
    scheduleRender();
  }

  function onPointerDown(e) {
    if (!mounted) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const u = uv(e);
    pointer = u;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      /* 某些环境不支持 pointer capture，不影响落墨 */
    }
    if (hand) {
      placeAt(u);
      return;
    }
    const hit = hitTest(u.x, u.y);
    if (hit) {
      sel = hit;
      drag = {
        stamp: hit,
        dx: (u.x - hit.x) * W,
        dy: (u.y - hit.y) * H,
        mode: 'move',
        moved: false,
      };
      touchActivity();
      emit('change', { action: 'select', piece: hit.pieceId });
      scheduleRender();
    } else if (sel) {
      sel = null;
      emit('change', { action: 'deselect' });
      scheduleRender();
    }
  }

  function onPointerMove(e) {
    if (!mounted) return;
    const u = uv(e);
    pointer = u;
    if (drag && drag.stamp) {
      const st = drag.stamp;
      const nx = clamp01(u.x - drag.dx / W);
      const ny = clamp01(u.y - drag.dy / H);
      if (
        drag.mode === 'move' &&
        !drag.moved &&
        Math.hypot((nx - st.x) * W, (ny - st.y) * H) > 3
      ) {
        drag.moved = true;
        repositionCount++; // 提起重摆：一次拖动记一次
        touchActivity();
      }
      st.x = nx;
      st.y = ny;
      pixelRev++;
      statsCache = null;
      scheduleRender();
      return;
    }
    if (hand) scheduleRender(); // ghost 跟着指针
  }

  function onPointerUp() {
    if (!mounted) return;
    if (!drag) return;
    const wasMove = drag.mode === 'move';
    drag = null;
    if (wasMove) emit('change', { action: 'reposition' });
    scheduleRender();
  }

  function bindEvents() {
    canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
    canvas.addEventListener('pointermove', onPointerMove, { passive: true });
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    // 不监听 canvas 的 pointerleave：pointer capture 期间它可能被触发，
    // 会把拖到纸外的拖动提前结束（drag 半途丢失）。用 window 上的 pointerup 兜底松手。
    window.addEventListener('pointerup', onPointerUp);
  }

  /* ---------- 公开 API（契约 §5，只有这些） ---------- */

  function mount() {
    if (mounted) return board;
    let cv = rootEl.tagName === 'CANVAS' ? rootEl : rootEl.querySelector('canvas');
    if (!cv) {
      cv = document.createElement('canvas');
      rootEl.appendChild(cv);
    }
    canvas = cv;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    canvas.style.maxWidth = '100%';
    canvas.style.touchAction = 'none';
    canvas.style.userSelect = 'none';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '水墨纸');
    if (rootEl !== canvas && rootEl.style) rootEl.style.maxWidth = '100%';

    ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('ink.mount: 无法取得 2D 上下文');

    texDpr = pickTextureDpr();
    paperTex = bakePaper(W, H, dpr); // 纸：离屏一次
    bakeAllTextures(); // 95 张墨纹理：全生命周期只此一次
    bindEvents();
    mounted = true;
    renderScene(false);
    emit('change', { action: 'mount' });
    return board;
  }

  function reset(roundArg) {
    round = Math.max(1, Math.round(num(roundArg, 1)));
    stamps = [];
    sel = null;
    hand = null;
    drag = null;
    animStamp = null;
    fading = false;
    undoCount = 0;
    repositionCount = 0;
    firstPickAt = null;
    firstPlaceAt = null;
    firstPlaceMs = 0;
    activity = [];
    pointer = { x: 0.5, y: 0.5 };
    settings.ink = DEFAULT_INK;
    settings.scale = DEFAULT_SCALE;
    settings.hue = 0;
    settings.rot = 0;
    pixelRev++;
    statsCache = null;
    if (mounted) scheduleRender();
    emit('change', { action: 'reset', round });
    return board;
  }

  function render() {
    if (mounted) renderScene(false);
    return board;
  }

  function clear() {
    stamps = [];
    sel = null;
    hand = null;
    drag = null;
    animStamp = null;
    fading = false;
    pixelRev++;
    statsCache = null;
    if (mounted) scheduleRender();
    emit('change', { action: 'clear' });
    return board;
  }

  function undo() {
    if (!stamps.length) return false; // 栈空：不动画面、不记账
    const top = stamps.pop();
    if (sel === top) sel = null;
    if (animStamp === top) {
      animStamp = null;
      fading = false;
    }
    undoCount++;
    touchActivity();
    pixelRev++;
    statsCache = null;
    if (mounted) scheduleRender();
    emit('change', { action: 'undo' });
    return true;
  }

  function selectPiece(pieceId) {
    const id = String(pieceId);
    const spec = SPEC_BY_ID.get(id);
    if (!spec || !offeredIds.has(id)) return board;
    if (hand === id) {
      hand = null; // 再点一次同一格 = 放回
      emit('change', { action: 'disarm', piece: id });
      scheduleRender();
      return board;
    }
    if (firstPickAt == null && firstPlaceAt == null) firstPickAt = now();
    hand = id;
    sel = null; // 手上有新块 ⇒ 滑杆接下来管它，不再改纸上旧的那笔
    touchActivity();
    emit('change', { action: 'pick', piece: id });
    scheduleRender();
    return board;
  }

  function applySetting(key, value) {
    settings[key] = value;
    if (sel) {
      // 落墨之后这块仍归滑杆管：调的是纸上那一笔本身（墨心踩过的坑 #5）
      sel[key] = value;
      pixelRev++;
      statsCache = null;
    }
    touchActivity();
    emit('change', { action: 'set', key, value });
    scheduleRender();
    return board;
  }

  function setInk(v) {
    let n = num(v, DEFAULT_INK);
    if (n > 1 && n <= 100) n /= 100; // 容忍 shell 传百分数
    return applySetting('ink', clamp(n, INK_MIN, INK_MAX));
  }

  function setScale(v) {
    let n = num(v, DEFAULT_SCALE);
    if (Math.abs(n) > 8) n /= 100; // 容忍 shell 传 50–180 的滑杆值
    return applySetting('scale', roundTo(clamp(n, SCALE_MIN, SCALE_MAX), 2));
  }

  function setHue(i) {
    let h = typeof i === 'string' ? HUES.findIndex((x) => x.id === i) : Math.round(num(i, 0));
    if (!(h >= 0 && h < HUES.length)) h = 0;
    return applySetting('hue', h);
  }

  function setRotation(deg) {
    let d = num(deg, 0);
    d = ((d % 360) + 360) % 360; // 归一到 [0,360)
    return applySetting('rot', d);
  }

  function stats() {
    const rev = pixelRev;
    if (!statsCache || statsCache.rev !== rev) statsCache = { rev, value: computeStats() };
    const out = Object.assign({}, statsCache.value);
    out.hue_used = statsCache.value.hue_used.slice(); // 不外泄内部数组
    return out;
  }

  function exportPng() {
    if (!mounted) return '';
    renderScene(true); // 导出档不画选中框 / ghost
    const url = canvas.toDataURL('image/png');
    renderScene(false); // 恢复界面态
    return url;
  }

  function on(event, cb) {
    if (event !== 'change' || typeof cb !== 'function') return () => {};
    listeners.push(cb);
    return () => {
      const k = listeners.indexOf(cb);
      if (k >= 0) listeners.splice(k, 1);
    };
  }

  const board = {
    mount,
    reset,
    render,
    undo,
    clear,
    selectPiece,
    setInk,
    setScale,
    setHue,
    setRotation,
    stats,
    exportPng,
    on,
  };
  return board;
}

export default createBoard;
