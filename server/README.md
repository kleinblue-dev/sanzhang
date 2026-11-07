# server/ — 「三张」后端（零依赖）

契约唯一真源：`../shared/contract.md`。本目录只实现契约 §3 的接口与数据文件，不自造字段。

## 1. 启动

```bash
# 在 app/ 目录下（推荐）
node server/server.mjs            # → http://127.0.0.1:8787

# 任意目录也行
node <path>/ink-fusion/app/server/server.mjs
```

同源同时提供 `/api/*` 与 `web/` 静态文件：浏览器打开 `http://127.0.0.1:8787/` 就是整站。
前端零构建、后端零依赖，**不需要 `npm install`**，只用 node 内置模块（node ≥ 18，本机 v24 实测）。

| 环境变量 | 默认 | 用途 |
|---|---|---|
| `PORT` | `8787` | 端口 |
| `HOST` | `127.0.0.1` | 监听地址；手机同局域网访问时设 `0.0.0.0` |
| `WEB_ROOT` | `../web` | 静态根目录（仅自验时临时指到别处，正常不用设） |

数据落在 `server/data/sessions.jsonl`（启动时自动创建目录与文件）。停服务 `Ctrl+C`。

## 2. 接口清单（contract §3）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/config` | — | `200 {copy:{…34 键}, limits:{pre:{min,max},post:{min,max}}, version:"1"}` |
| GET | `/api/scripts` | — | `200 {lines:{"1":[{pre,post}…],"2":[…],"3":[…]}}`，每轮 4 条 |
| POST | `/api/session` | `{}`（空 body 也可） | `200 {session_id, condition:"A"\|"B"}`，A/B 1:1 随机 |
| POST | `/api/session/:id/state` | `{phase:"pre"\|"post", values:{q1,q2,q3,ux1?,ux2?}}` | `200 {ok:true}` |
| POST | `/api/session/:id/sheet` | `{round:1\|2\|3, metrics:{…契约 §4}}` | `200 {ok:true}` |
| POST | `/api/session/:id/finish` | `{signature:{strokes:int}, steps:[{id:string,ms:int}]}` | `200 {ok:true, csv_url:"/api/export.csv"}` |
| GET | `/api/session/:id` | — | `200 {session:{…}}`（调试） |
| GET | `/api/export.csv` | — | `200 text/csv`，一行一会话，首行表头 |

行为细节：

- `finish` **幂等**：同 id 第二次起直接 200，不新增任何记录行（并发也共享同一次写盘）。
- `state` 取值 1–7 整数；`pre` 只收 q1–q3，`post` 收 q1–q3 + 可选 ux1/ux2。
- `sheet` 的 `metrics` 按契约 §4 校验类型（`hue_used` 必须长度 5 的整数数组，`first_group` 为 0/1/2 或 null），未知键丢弃，缺省键允许。
- body 上限 256KB（超出 413）；JSON 解析失败 400；未知路由 404；已知路由错方法 405。
- 开发期 CORS：所有响应带 `Access-Control-Allow-Origin: *`，`OPTIONS *` → 204。
- 静态：`GET /` → `web/index.html`；`GET /<file>` → `web/<file>`；仅白名单后缀 `.html .js .css .svg .ico`，其余 404；`..` 路径穿越 403；静态响应 `Cache-Control: no-store`（改前端文件刷新即生效）。

## 3. 数据字段

### `data/config.json`（界面文字唯一来源，34 键）

- `version`: 固定 `"1"`。
- `limits`: `{pre:{min:1,max:7}, post:{min:1,max:7}}`。
- `copy`: 键集 = 契约 §3 的 34 个键，**不得增删**（前端 `tests/copy.mjs` 会比对）。硬上限：标题 ≤8 字、提示/问题/承诺 ≤16 字、按钮 ≤4 字；禁医疗词（诊断/治疗/治愈/疗效…）。
  - 标题：`gate_title, pre_title, sheet_title, signature_title, post_title, cards_change_title, cards_process_title, replay_title, done_title`
  - 按钮：`gate_start, pre_next, sheet_done, sheet_undo, signature_skip, post_next, done_export, done_again`
  - 其余为提示/问题/承诺/报错。

### `data/scripts.json`

`lines["1"|"2"|"3"]` 各 4 条候选 `{pre, post}`，各 ≤16 字。`pre` 只「给动作 / 给许可」（祈使句），`post` 只承接不评价（不得出现「很好/很棒/说明你/意味着」）。前端按 `session_seed % n` 选一条，可复现。

### `data/sessions.jsonl`（每行一个事件，追加写，不删不改）

| type | 字段 |
|---|---|
| `create` | `session_id, condition, started_at` |
| `state` | `session_id, phase, values{q1,q2,q3,ux1?,ux2?}` |
| `sheet` | `session_id, round, metrics{…§4}` |
| `finish` | `session_id, finished_at, signature{strokes}, steps[{id,ms}]` |

启动时回放该文件重建内存索引，重启不丢数据；坏行跳过不阻塞启动。

### `GET /api/export.csv` 列

会话族 → 状态族 → 过程族，一行一会话：

```
session_id, condition, started_at, finished_at, duration_seconds,
state_pre_q1..q3, state_pre_sum,
state_post_q1..q3, state_post_sum,
state_delta_q1..q3, state_delta_sum,
post_ux1, post_ux2,
signature_strokes, steps_json,
sheet1_<15 个指标>, sheet2_<15>, sheet3_<15>
```

`<15 个指标>` 顺序 = 契约 §4：`pieces_used, blank_ratio, center_bias, ink_mean, ink_sd, hue_used, undo_count, reposition_count, first_place_ms, active_ms, scale_mean, scale_range, groups_used, group_switches, first_group`。
`hue_used` 用分号连接（`3;1;0;0;0`）；`steps` 以 JSON 字符串存一列；缺失值留空。
CSV 带 UTF-8 BOM + CRLF，Windows Excel 双击直接打开不乱码（`fetch().text()` 会自动剥 BOM）。

## 4. 改文案（不用动前端、不用重启）

1. 直接编辑 `data/config.json`（或 `data/scripts.json`）。
2. 下一次 `GET /api/config`（`GET /api/scripts`）即返回新值——服务按文件 mtime 缓存，改了就失效。
3. 改前端：文件落在 `web/` 下即可，刷新浏览器生效（静态资源 no-store）。
4. **增删字段必须先改 `../shared/contract.md`**，再改后端 + 前端兜底 + 测试；后端不认契约外字段。

## 5. 自验

```bash
node --check server/server.mjs && node --check server/store.mjs   # 语法
node tests/api.mjs                                               # 端到端 API 断言（Lead 维护）
```

⚠️ `GET /api/export.csv` 导出的是**全部历史会话**（研究回收语义），因此 `tests/api.mjs` 断言「CSV 行数 = 表头+2」要求跑前数据文件为空：

```powershell
# 清空历史会话（PowerShell）
Remove-Item server\data\sessions.jsonl -ErrorAction SilentlyContinue
```

手工自验一次示例（服务已起在 8787）：

```powershell
$s = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/session
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/api/session/$($s.session_id)/state" -ContentType application/json -Body '{"phase":"pre","values":{"q1":5,"q2":4,"q3":6}}'
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/api/session/$($s.session_id)/finish" -ContentType application/json -Body '{"signature":{"strokes":1},"steps":[{"id":"gate","ms":1200}]}'
(Invoke-WebRequest http://127.0.0.1:8787/api/export.csv).Content
```
