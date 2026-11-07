# 契约 v1（前后端分离唯一真源）

> 改接口先改本文件。三个实现方（server / shell / ink）都只认这里。

## 0. 硬规则

| # | 规则 |
|---|---|
| R1 | 前端**不发任何第三方请求**；只打 `API_BASE`（同源默认空串） |
| R2 | 界面文字全部来自 `GET /api/config`；前端不得写死文案（除 aria-label） |
| R3 | 每屏可见文字预算：标题 ≤8 字，提示 ≤16 字，按钮 ≤4 字；**无段落** |
| R4 | 字段名只此一份；前后端都不得自造 |
| R5 | 后端零依赖（node 内置模块）；前端零构建（原生 ESM） |
| R6 | 任何一屏都要能在 375×667 内完成，不横向滚动 |

## 1. 目录与归属

```
app/
├─ shared/contract.md        ← 本文件（Lead）
├─ server/                   ← 后端（backend 唯一写权）
│  ├─ server.mjs             HTTP 入口，端口 8787
│  ├─ store.mjs              JSONL 存储
│  └─ data/{config.json,scripts.json,sessions.jsonl}
├─ web/                      ← 前端
│  ├─ index.html  style.css  app.js   （shell 唯一写权）
│  └─ ink.js                          （ink 唯一写权）
└─ tests/                    ← 验收脚本（Lead）
```

## 2. 屏幕序列（状态机，单向前进；仅 `sheet` 内可 undo 笔）

| order | id | 说明 |
|---|---|---|
| 1 | `gate` | 授权卡口 + 三条承诺 + 开始 |
| 2 | `pre` | 三题 1–7 |
| 3 | `sheet` | ×3 轮；每轮前 1 条引导，收笔后 1 条承接 |
| 4 | `signature` | 自由一笔（可跳过） |
| 5 | `post` | 同三题 + 2 题体验 |
| 6 | `cards` | 双卡：变化卡 + 过程卡（**必须在 post 之后**） |
| 7 | `replay` | 三张横展回放 |
| 8 | `done` | 导出 / 重来 |

## 3. HTTP API（JSON，UTF-8，`/api` 前缀）

### GET `/api/config`
→ `200 { copy: {…}, limits: { pre:1..7, post:1..7 }, version:"1" }`

`copy` 键（**唯一合法键集**，值均为短句）：
```
gate_title, gate_promise1, gate_promise2, gate_promise3, gate_start,
pre_title, pre_q1, pre_q2, pre_q3, pre_next,
sheet_title, sheet_hint, sheet_done, sheet_undo, sheet_tray,
signature_title, signature_hint, signature_skip,
post_title, post_q1, post_q2, post_q3, post_ux1, post_ux2, post_next,
cards_change_title, cards_process_title, cards_hint,
replay_title, replay_hint,
done_title, done_export, done_again,
err_offline
```

### GET `/api/scripts`
→ `200 { lines: { "1":[{"pre":"…","post":"…"},…], "2":…, "3":… } }`
每轮 ≥3 条候选，前端按 `session_seed % n` 选一条（可复现）。

### POST `/api/session`
body `{}` → `200 { session_id, condition }`
- `condition`: `"A"` 三张全量 / `"B"` 只第一张（对照臂，服务端随机 1:1）

### POST `/api/session/:id/state`
body `{ phase:"pre"|"post", values:{q1,q2,q3,ux1?,ux2?} }` → `200 {ok:true}`
- 取值范围 1–7；缺 `post` 的 `ux1/ux2` 允许

### POST `/api/session/:id/sheet`
body `{ round:1|2|3, metrics:{…见 §4} }` → `200 {ok:true}`

### POST `/api/session/:id/finish`
body `{ signature:{strokes:int}, steps:[{id:string,ms:int}] }` → `200 {ok:true, csv_url:"/api/export.csv"}`
- 幂等：同 id 重复调用返回 `ok:true` 且不新增记录

### GET `/api/session/:id`
→ `200 { session: {…} }`（调试用）

### GET `/api/export.csv`
→ `200 text/csv`，首行表头；一行一会话

### 测试开关（仅测试用，生产不设）
`FORCE_CONDITION=A|B`：固定对照臂。不设则服务端 1:1 随机。
- A 臂：3 张纸；B 臂：只 1 张（对照臂），流程在 signature 前收束。
- `tests/e2e.mjs` 用 `EXPECT_SHEETS` 断言纸数。

### 静态资源
`GET /` → `web/index.html`；`GET /<file>` → `web/<file>`（仅白名单后缀 `.html .js .css .svg .ico`，路径穿越返回 403）

## 4. 过程指标（每张纸，ink.js 计算，全部为数字或数字数组）

```
pieces_used       int     落墨次数（同块可重复，按笔计）
blank_ratio       float   整纸留白 0–1
center_bias       float   重心偏移 0–1
ink_mean          float   墨色均值 0–1
ink_sd            float   墨色标准差
hue_used          [int]   长度为 5 的计数数组（墨/赭石/花青/藤黄/朱砂）
undo_count        int
reposition_count  int
first_place_ms    int     首次取块→首次落墨
active_ms         int     去空档后的动手时长（间隔 >10s 不计）
scale_mean        float
scale_range       float
groups_used       int     0–3
group_switches    int
first_group       int|null 0=远 1=中 2=点
```

## 5. ink.js 接口（shell 只调这些）

```js
// web/ink.js  —— 默认导出工厂
export function createBoard(rootEl, opts = {}) → board

board.mount()                       // 建 canvas、绑事件
board.reset(round)                  // 清纸、清撤销栈、重置滑杆
board.render()                      // 重绘
board.undo()                        // 撤销上一笔（栈空返回 false）
board.clear()                       // 清纸（不算撤销）
board.setInk(v01) / board.setScale(v) / board.setHue(i) / board.setRotation(deg)
board.selectPiece(pieceId)          // 从托盘取块
board.stats()                       // 返回 §4 对象（当前轮）
board.exportPng()                   // dataURL
board.on('change', cb)              // 任一状态变化后回调
// opts: { width=800, height=560, dpr=2, reducedMotion=false, piecesPerRound=19 }
```

托盘 DOM 由 shell 渲染（`#tray`），ink.js 只暴露 `PIECES` 常量：
```js
export const PIECES = [{ id, group:0|1|2, name }]  // 19 块
```

## 6. 页面 DOM 契约（shell 建，ink 只认这两个）

| id | 用途 |
|---|---|
| `#paper` | `<canvas>` 挂载点，ink.js 独占 |
| `#tray` | 托盘容器，shell 渲染；每块 `[data-piece]`，点击调 `board.selectPiece` |
| `#stage` | 当前屏容器；每屏 `data-screen="gate|pre|sheet|…"` |

## 7. 错误与降级

| 场景 | 行为 |
|---|---|
| `/api/config` 失败 | 用 `web/app.js` 内 **仅一份** 兜底文案（与 config.json 同值），顶部一行 `err_offline` |
| `/api/session` 失败 | 本地生成 `session_id`，数据写 `localStorage`，`condition` 取 `"A"` |
| 提交失败 | 进 `done` 前重试 2 次；仍失败则本地缓存，导出按钮改走本地 CSV |

## 8. 验收（tests/）

1. `node tests/api.mjs` — 起服务，打全接口，断言字段与 CSV 行数。
2. `node tests/copy.mjs` — 拉 `/api/config`，断言每串长度 ≤16 字、键集完全等于 §3。
3. `node tests/e2e.mjs` — 无头浏览器走完 8 屏，断言：每屏 `data-screen` 出现、375 宽 `scrollWidth=375`、卡片在后测之后、CSV 可下载。
4. `node tests/metrics.mjs` — 注入假事件序列，断言 §4 每个字段类型/范围。

---

## 变更记录

### v1.1（2026-11-07 实现后回填）
1. §4 指标实为 **15 项**：原文写「14 个字段」漏计 `first_group`。以 `web/ink.js` 的 `stats()` 与 `web/app.js` 的 `METRIC_KEYS` 为准（15 项已对齐）。
2. 过程卡的指标名直接显示 §4 字段名（不再另造中文名），控件文案用符号 + `aria-label`——规避 R2（文案只来自 config）与「文字要少」的冲突。下一版若要在界面显示中文指标名，再补 `copy.metric_*` 键。
3. 屏幕 `sheet` 的 `#stage` 额外挂 `data-round="1|2|3"`（轮次断言用）；`done` 屏无 `data-next`，用 `[data-export]` / `[data-again]`。
4. B 臂（只 1 张）是契约内行为，不是缺陷；e2e 已按臂参数化。