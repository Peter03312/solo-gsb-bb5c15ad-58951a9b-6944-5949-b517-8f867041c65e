# 定向越野打卡争议复核系统

主办方设置**按顺序通过的关卡组**（每组含若干**可替代点位**，并可录入**组截止秒数**与统一的**终点截止秒数**）；
系统录入选手的**唯一出发打卡**以及途中、终点打卡（每条含记录号、点位、距发枪秒数），自动核算成绩、
支持裁判作废/更正打卡并**重算**，以及**发布冻结**成绩版本。

技术栈：**Node.js + Express + React（Vite）+ SQLite（better-sqlite3）**。

---

## 一键启动（推荐，Docker Compose）

前置要求：安装 Docker 与 Docker Compose。

```bash
docker compose up --build
```

启动后：

- 打开网页：**http://localhost:3000**
- API 根路径：`http://localhost:3000/api/...`
- 容器启动时自动建表（`server/src/schema.sql`）并初始化 SQLite 数据库；
  默认写入一套演示赛事与打卡数据（含逆序多余打卡、终点超时、组未完成、并列、重复出发等待争议样例）。
- 数据库持久化在命名卷 `orienteering-data`（容器内 `/data/orienteering.db`）。

停止：`docker compose down`（数据保留）；连同数据清除：`docker compose down -v`。

仅用 Dockerfile：

```bash
docker build -t orienteering-review .
docker run -p 3000:3000 -v "$PWD/data:/data" -e SEED=1 orienteering-review
```

---

## 本地开发运行

要求 Node.js ≥ 18。

```bash
# 安装依赖
npm run install:all

# 同时启动后端(:3000) 与 Vite 前端(:5173)
npm run dev
```

- 前端开发地址：**http://localhost:5173**（`/api` 自动代理到 3000）
- 后端地址：http://localhost:3000
- 首次运行可用 `SEED=1` 写入演示数据：`SEED=1 npm run dev:server`

生产构建（后端单端口同时提供静态页面与 API）：

```bash
npm run build      # 构建 web/dist
npm start          # http://localhost:3000
```

---

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 后端监听端口 |
| `DB_FILE` | `data/orienteering.db` | SQLite 数据库文件路径，首次启动自动建表 |
| `SEED` | 未设置 | `1` 时在空库中初始化演示赛事（仅生效一次） |
| `WEB_DIST` | `web/dist` | 构建后前端静态目录 |

网页地址与端口：**http://localhost:3000（Docker / 生产）**，开发模式为 **http://localhost:5173**。

---

## 成绩规则

1. 每个选手必须有且仅有一条 `kind=start` 的出发打卡（点位须等于起点）。
2. 从出发后的读数中构造**最早有效链**：
   - 关卡组按设置顺序依次通过，每组在其可替代点位中任选其一；
   - 选中打卡的距发枪秒数必须**严格递增**（`>`，相等不算），每组取满足条件的**最早**一条（贪心即最优：
     更早的选择只会给后续更大的时间窗口）；
   - 若该组设置了组截止秒数，还须不晚于该秒数。
3. 终点打卡必须在最后一组之后、且距发枪秒数不超过终点截止秒数（`<=`，刚好在截止点有效）。
4. **逆序打卡与多余打卡**（如途中再次经过起点、无关点位、晚于终点的打卡）不作为任何组/终点的完成依据。
5. 完成者按耗时（终点秒数 − 出发秒数）升序排名，**同耗时并列同名次**。
6. 无有效链时指出首个失败位置：
   - 出发缺失/不唯一/点位错误；
   - 第一个未在严格递增且截止前通过的关卡组（含组名与原因）；
   - 终点缺失或**终点超时**（给出实际秒数与截止值）。

## 裁判操作（争议复核）

- **作废**打卡：填写原因，读数标记 voided 并不再参与核算；
- **更正**打卡：填写原因与新点位/新秒数（非负），系统保留原值、新值、原因、时间，并重算成绩。
- 作废/更正影响的是**当前实时成绩**；已发布版本不受影响。

## 发布冻结与赛事修订

- 每次关卡设置、批量导入、作废/更正、发布都会推进赛事 `revision` 修订号。
- 导入与发布必须在请求中携带 `expectedRevision`；与当前修订不一致时返回 **HTTP 409 及 `currentRevision`**（前端提示刷新），
  避免覆盖他人更改。
- 发布将**关卡配置 + 全部有效读数（作废读数除外）+ 当次成绩**整体快照写入 `publication` /
  `published_result` 表，版本号递增；历史版只读，后续更正**不修改任何历史版**。
- 批量导入校验：
  - 秒数必须为非负整数，出现**负秒数 → 整批拒绝**；
  - **同一记录号内容不同（批次内或与库中冲突）→ 整批拒绝**，事务回滚全部不入库；
  - 同一记录号内容完全一致 → 幂等跳过。

导入数据格式（JSON 数组，或 `recordNo,bib,point,seconds,kind,name` 的 CSV/TSV）：

```json
[
  { "recordNo": "R1001", "bib": "007", "name": "周杰", "point": "S",  "seconds": 0,    "kind": "start" },
  { "recordNo": "R1002", "bib": "007", "point": "A1", "seconds": 320,  "kind": "enroute" },
  { "recordNo": "R1003", "bib": "007", "point": "B2", "seconds": 780,  "kind": "enroute" },
  { "recordNo": "R1004", "bib": "007", "point": "F",  "seconds": 1100, "kind": "finish" }
]
```

---

## 页面说明

- **成绩排名**：实时成绩、名次（含并列）、状态、失败组/超时说明、每人的最早有效链。
- **争议复核**：按号码布查看打卡，执行作废/更正并查看完整操作留痕。
- **打卡导入**：批量粘贴导入，展示整批校验结果。
- **关卡设置**：维护起点/终点、终点截止、顺序关卡组、组内替代点位与组截止。
- **发布冻结**：发布新版本、浏览各历史冻结版的关卡/读数/成绩。

## 主要 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/event` | 当前赛事配置与修订号 |
| POST | `/api/setup` | 设置关卡组（body 需 `expectedRevision`） |
| POST | `/api/punches/import` | 批量导入（整批校验，409 过期 / 400 拒绝） |
| GET | `/api/punches?bib=` | 打卡与审计记录 |
| POST | `/api/punches/:id/void` | 作废（reason 必填） |
| POST | `/api/punches/:id/correct` | 更正（newPoint/newSeconds/reason） |
| GET | `/api/results` | 当前实时成绩排名 |
| POST | `/api/publications` | 发布冻结快照（需 `expectedRevision`） |
| GET | `/api/publications` / `/api/publications/:version` | 版本列表 / 历史冻结版详情 |

## 目录结构

```
server/            Express + better-sqlite3 后端
  src/index.mjs    API 路由
  src/scoring.mjs  最早有效链与排名算法
  src/db.mjs       SQLite 连接/建表/修订号
  src/seed.mjs     演示数据
  src/schema.sql   数据库表结构
  e2e-test.mjs     端到端断言（35 项，覆盖核算/整批拒绝/修订锁/冻结）
web/               React + Vite 前端
  src/components/  五个功能页面
Dockerfile         多阶段构建（前端构建 + 后端 + 运行镜像）
docker-compose.yml 一键启动、建表、初始化数据，端口 3000
```

## 端到端测试

```bash
# 终端 1：干净数据库启动服务器
rm -f data/orienteering.db*
SEED=1 node server/src/index.mjs

# 终端 2：运行 35 项断言
node server/e2e-test.mjs http://localhost:3000
```
