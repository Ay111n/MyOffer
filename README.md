# MyOffer · Offer 选择助手

> 用结构化事实、确定性评分和可追溯快照，把 2–3 份 Offer 摆上桌算清楚再签。

[![Backend](https://img.shields.io/badge/backend-Python%203.12%20%2B%20FastAPI-009688?logo=fastapi&logoColor=white)](backend/)
[![Frontend](https://img.shields.io/badge/frontend-Next.js%2016%20%2B%20React%2019-000000?logo=nextdotjs&logoColor=white)](frontend/)
[![存储](https://img.shields.io/badge/存储-仅进程内存-5b7cfa)](#隐私与临时数据)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## 项目简介

MyOffer 帮毕业生比较 2–3 份全职 Offer。每份先填七项基本信息，再回答三道偏好比较和一道买房意向题。报告对比经济回报、职业成长、工作体验；未补齐全部基本信息时只展示已有分项，不给综合排名。

税后现金、城市购买力、购房压力及三维评分由当前规则确定性计算，使用城市费率、房价和生活成本参考数据。缺少社保、公积金细节时，报告标记估算。

## 使用流程

```
七项基本信息 → 偏好问卷 → 三维对比报告 → 按需补充信息
```

1. 默认有 Offer A、B，最多添加到 C；无需填写公司或岗位名称。
2. 每份填写城市、税前月薪、固定薪数、业务范围、承担层级、周工时和工作天数。奖金、福利、带教、反馈、通勤等放在可展开的补充表单。
3. 在填写页完成偏好问卷，并可手动调整三维权重。报告展示排名、三维分、关键数字与加权贡献解释；展开后查看输入和税费明细。
4. 可随时导出输入与偏好 JSON，导入后按当前规则重算并继续填写。旧版导出文件不兼容。报告可打印或保存 PDF。

权重由三道五档两两比较题计算，手动调整时每维至少 5%。综合分按未舍入的三维分加权计算，展示到一位小数；展示分相同即并列。城市范围由规则文件维护。

## 隐私与临时数据

- 不创建用户账号，不写入磁盘，不使用外部数据库。
- Offer、偏好、回答、遥测和结果快照只保存在后端进程内的 SQLite 状态中。
- 后端重启、进程退出或开发热重载后，当前比较状态会清空。
- 同一浏览器身份创建新的比较时，之前的临时比较会被替换。
- 闲置 2 天的身份和比较每分钟回收；比较和身份各最多 200 个，超限按最近访问时间淘汰最旧状态。每个比较仅保留最近 10 份快照，请及时导出重要输入。
- SQLite 状态页最多 96MiB，容量不足返回 `503 storage_capacity`；这不包含 Python/Node 本身的内存，systemd 的 450MiB 仍是进程组最终护栏。模型配置最多 200 个身份，有凭据的配置满额时拒绝新增。
- 遥测默认关闭，上报返回 `accepted=0`。暂无正式分析消费者；需要诊断时由维护者显式开启，白名单事件最多保留 24 小时、每比较 200 条、全局 10,000 条。当前没有公开遥测读取接口。
- 认证 token 通过 `SESSION_SECRET` 的 HMAC-SHA256 摘要查找；密钥至少 32 字符，轮换密钥会使旧 Cookie 失效。
- 生产部署使用单个 uvicorn worker，保证所有临时状态和进程内限流计数位于同一进程。

## 快速开始

### 环境要求

- Python 3.12 或更高版本
- Node.js 22.19 或更高版本（后端模型接入也需要 Node.js）
- `pip` 或 `uv`

### 启动后端

```bash
cd backend
pip install -e '.[dev]'
cd ai-runtime
npm ci --omit=dev
cd ..
uvicorn app.main:app --reload --port 8000
```

### 启动前端

```bash
cd frontend
npm install
npm run gen:api
npm run dev
```

前端默认运行在 <http://localhost:3000>，后端默认运行在 <http://localhost:8000>。开发环境下，Next.js 将 `/api/*` rewrite 到后端。

### Makefile 命令

```bash
make backend       # 启动后端
make frontend      # 启动前端
make gen-api       # 重新生成前端 API 类型
make test          # 后端全量测试
make test-unit     # 后端单元和金标准测试
make e2e           # 前端单测与 Playwright 冒烟
make regression    # 发布前回归
```

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Next.js 16、React 19、TypeScript、TanStack Query、Zustand、openapi-fetch、Recharts、Tailwind CSS |
| 后端 | Python 3.12、FastAPI、Uvicorn、SQLAlchemy 2、Pydantic 2、PyYAML |
| 模型接入 | 服务端 Node.js + `@earendil-works/pi-ai` 1.0.2，通过私有标准输入/输出连接 FastAPI |
| 状态 | 进程内 SQLite 临时状态，重启清空 |
| 规则 | YAML 字段、问题、维度、评分、可靠性、风险、偏好和城市规则 |
| 测试 | pytest、Ruff、Vitest、Playwright |

## 项目结构

```
MyOffer/
├─ backend/
│  ├─ app/
│  │  ├─ api/routes/       # HTTP 路由
│  │  ├─ domain/           # 纯函数三维报告引擎
│  │  ├─ services/         # 业务写入、问卷和重算
│  │  ├─ models/           # SQLAlchemy 实体
│  │  ├─ schemas/          # Pydantic API 模型
│  │  ├─ rules_runtime/    # YAML 规则加载、校验和镜像
│  │  ├─ rules/            # 当前规则定义（report.yaml + 城市数据）
│  │  └─ db/               # 进程内 SQLite 会话和模型基类
│  ├─ tests/
│  └─ pyproject.toml
├─ frontend/
│  ├─ app/                 # 首页、信息补全和对比报告（含明细页）
│  ├─ components/          # 共享组件
│  ├─ lib/api/             # API 客户端和生成类型
│  ├─ lib/flow.ts          # 流程阶段与路由映射
│  └─ e2e/                 # Playwright 冒烟测试
├─ deploy/                 # 当前静态前端 + systemd/nginx 部署文件
├─ openapi.json            # 自动导出的 OpenAPI 契约
└─ Makefile
```

## 配置与部署

顶栏的「模型配置」进入 `/settings/models`，支持 ChatGPT、Claude、GitHub Copilot 的订阅授权，以及 Gemini、DeepSeek、OpenRouter、GLM Coding Plan、Kimi For Coding 等服务商的接入。页面按当前安装的 pi-ai 库展示各服务商支持的账号授权和 API Key 方式，模型目录也来自库本身。先连接服务商，再选择默认模型；「测试连接」会向选定模型发送固定的短消息，消耗少量模型额度。模型目录不代表账号一定有对应权限，以连接测试和服务商权限为准。

模型密钥和 OAuth 令牌按匿名浏览器身份隔离，仅保存在服务端 Node 子进程内存。配置页不会创建或替换 Offer 比较，浏览器刷新后保留连接；后端重启、AI 子进程退出后需重新连接。密钥、授权码和令牌不会通过配置查询回显或写入浏览器存储，服务端不会自动使用环境中的共享模型密钥。OAuth 令牌刷新由 pi-ai 在凭据锁内完成。

授权时打开页面给出的服务商链接，完成登录后回到配置页；设备授权按页面显示的设备码操作。若远程部署的授权回调跳到本机地址且无法打开，复制浏览器地址栏中的完整回调地址，粘贴到配置页提交；也可以取消重试。账号授权最长等待 10 分钟，连接测试最长等待 60 秒。授权和测试在后台进行，页面轮询状态，不会长时间占用比较状态的数据库门闩。

对比报告的总体、经济回报、职业成长和工作体验四部分各有独立的「生成解读」按钮。每次点击只为所在部分调用一次默认模型，可按需生成、取消或重新生成，不影响其他部分的结果。后端只发送当前报告快照中的 Offer 字母、城市、权重、分数及汇总指标，不发送自由文本笔记或模型凭据。四份解读分别与报告快照编号绑定，报告更新后需按需重新生成；结果暂存在服务端进程内，当前标签页可在短时间内刷新恢复。每次生成会消耗所选服务商额度，报告计算与排名始终由确定性规则完成。接入参考：[pi-ai README](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md)。

生产后端机器也需要 Node.js 22.19+，同步 `backend/ai-runtime/` 后执行 `npm ci --omit=dev`；FastAPI 按需启动私有 Node 子进程，无需增加公开端口或运行 Node Web 服务。现有静态前端部署方式保持兼容。

开发环境可复制 `.env.example` 为 `.env`。生产环境使用 `deploy/env.production.example`，并通过 `deploy/server-bootstrap.sh`、`deploy/server-configure.sh` 配置 Python 环境、systemd、nginx 和静态前端目录。`server-configure.sh` 要求显式传入 `PUBLIC_HOST`（公网域名或 IP）；无证书的 HTTP 阶段会写入 `ALLOW_INSECURE_COOKIE=1` 显式确认会话 Cookie 不受 TLS 保护，补上 HTTPS 后删除该行并置 `COOKIE_SECURE=true`。

生产前端构建为静态文件：

```bash
cd frontend
npm run build
```

生成的 `out/` 由 nginx 托管，`/api/` 和 `/healthz` 反向代理到本机 8000 端口。后端使用单 worker 运行，以保持进程内临时状态一致。

开源代码发布于 [GitHub](https://github.com/Ay111n/MyOffer)，采用 MIT 许可；私有开发仓库保留完整历史，开源仓库独立维护经过脱敏的提交历史。

已有服务器可用 `deploy/server-sync.sh <已推送的完整提交ID> <静态产物tar.gz>` 同步。脚本以 root 执行，默认从 GitHub 开源仓库取指定提交；需要其他来源时可用 `MYOFFER_REPOSITORY` 指定仓库地址，并提前配置服务器访问权限。脚本保存源码、静态产物、私密环境和服务配置备份后发布；依赖与原有密钥保留，失败自动回滚。发布后服务器 `/srv/myoffer` 也是 Git 工作区，可核对开源发布提交。重启会清空所有进程内比较和模型连接。首次初始化依赖仍使用 bootstrap 脚本。

## 测试与 API 类型

```bash
cd backend && pytest -q
cd backend && ruff check app tests
cd backend/ai-runtime && npm test
cd frontend && npm run typecheck
cd frontend && npm run lint
cd frontend && npm run test
cd frontend && npm run build
```

当后端路由或 schema 发生变化时，在仓库根目录执行：

```bash
make gen-api
```

该命令从后端导出的 OpenAPI 契约更新 `frontend/lib/api/schema.d.ts`。

## 开发约定

先安装 `backend` 的开发依赖（`python -m pip install -e '.[dev]'`），lint 使用 `python -m ruff`，避免依赖全局 PATH。全局闸门按 FIFO 唤醒，等待超过 8 秒返回 `503 server_busy`。`/healthz` 检查存活，不访问共享连接；`/readyz` 在闸门内执行 `SELECT 1` 并检查规则镜像就绪。服务启动配置 INFO 日志，城市过期提醒合并为一条。

一次性城市采集脚本与证据位于 `tools/city-data/expansion/`。城市数据的维护决定与过期清单位于 [维护记录](tools/city-data/MAINTENANCE.md)，数值更新必须带官方来源、适用年度和受影响字段，不能用修改日期代替复核。

- 规则配置错误在启动阶段直接失败，不等待外部数据库或迁移。
- 写请求统一经过进程内锁、状态更新、重算、快照提交流程。
- 结果快照用于当前进程内的回看和解释，不构成持久化历史记录。
- API 错误使用统一 JSON 包络，事实字段和遥测 payload 均执行白名单校验。

## License

[MIT](LICENSE) © 2026 Ay1n
