# 三张 · 水墨自观察（前后端分离版）

一次 8–12 分钟的自观察：摆三张墨 → 前后各测一次 → 两张卡（变化 / 过程）。

## 跑起来

```bash
node app/server/server.mjs          # 默认 8787
# 打开 http://localhost:8787
```

或双击 `start.bat`。

## 目录

```
app/
├─ shared/contract.md    接口与字段唯一真源（改接口先改它）
├─ server/               后端：API + 文案 + 脚本 + JSONL 存储（零依赖）
│  └─ data/config.json   改文案 → 刷新即生效，不用动前端
│  └─ data/scripts.json  改引导语 → 同上
└─ web/                  前端：静态，可单独部署
   ├─ index.html style.css app.js   8 屏状态机
   └─ ink.js                        墨引擎（19 块、墨分五色、14 项读数）
```

## 分界线：像素不出设备

- 前端：渲染、落墨、读像素、算指标
- 后端：文案、脚本、会话、导出
- 只传 JSON，**永远不传图**；回放用本地 dataURL

## 改东西改哪

| 想改 | 改 | 是否要重新部署前端 |
|---|---|---|
| 一句话文案 | `server/data/config.json` | 否 |
| 引导语 | `server/data/scripts.json` | 否 |
| 墨迹手感 | `web/ink.js` | 是 |
| 流程顺序 | `web/app.js` | 是 |
| 数据字段 | `shared/contract.md` → 两端 | 是 |

## 验收

```bash
node tests/run-all.mjs   # 全部四套：接口 31 / 墨引擎 12 / A 臂 43 / B 臂 35
node tests/api.mjs       # 接口 / 文案预算 / 幂等 / CSV
node tests/metrics.mjs   # 墨引擎 15 项读数 + 仪器有效性
node tests/e2e.mjs       # 真浏览器 375×667 走完 8 屏（真坐标点击）
```

`tests/_shots/` 里是每屏截图。文案热改已验证：改 `server/data/config.json` 后**不重启**服务，`GET /api/config` 立即返回新值。

## 部署

| 模式 | 怎么上 | 有什么 | 缺什么 |
|---|---|---|---|
| **静态演示**（已上线） | `gh-pages` 分支 = `web/` 四个文件 | 8 屏全流程、摆墨、双卡、本地导出 | 无后端：不落库、只有 A 臂、顶部显示离线 |
| **完整** | 任一 Node 主机跑 `node server/server.mjs` | 加上：数据落库、A/B 随机臂、服务端 CSV | 免费主机磁盘临时（见 `render.yaml` 注释） |

前后端分域部署：改 `web/index.html` 里 `<meta name="api-base" content="https://后端域名">` 即可，JS 一行不用动（服务端已开 CORS）。

## 边界

- 不是医疗、不是心理测验；不解释、不评分、不诊断。
- 数据默认只在本机 `server/data/sessions.jsonl`；前端 localStorage 只做提交失败时的兜底。
