# TeXHub 操作手册（面向 AI Agent）

> **渐进式披露**：本文是入口，只放「always needed」的内容。
> 细节按任务拆分在 `docs/texhub/`，**需要哪块再读哪块**，不必一次性全读。
>
> 核实基准：`E:\dolphin\texhub-ai\backend\texhub-server`（Actix-Web 主 API）、
> `backend/texhub-broadcast`（Yjs 协同）、`backend/infra-server`（登录鉴权）、
> `frontend/texhub-web/src/config/app/config-pro.ts`（线上配置）。

## 文档地图

| 你要做的事 | 读哪份 |
|---|---|
| 查端点速查表、看操作准则 | [docs/texhub/00-cheatsheet.md](docs/texhub/00-cheatsheet.md) |
| 拿 token（refreshToken 换 accessToken） | [docs/texhub/01-auth.md](docs/texhub/01-auth.md) |
| 拉文件树、取回文件内容、整项目下载 | [docs/texhub/02-read.md](docs/texhub/02-read.md) |
| **改已有文件内容**（Yjs 通道）、上传新文件 | [docs/texhub/03-write.md](docs/texhub/03-write.md) |
| 建目录、重命名、移动、删除 | [docs/texhub/04-manage.md](docs/texhub/04-manage.md) |
| 触发编译、查日志、取 PDF | [docs/texhub/05-compile.md](docs/texhub/05-compile.md) |

## 四条最关键的约束

1. **公开 REST API 无法修改已有文件的内容**。`/tex/file/ver/add` 只写历史快照，不改文档；
   `/tex/ul/file/upload` 因 `UNIQUE(parent,name,file_type)` 约束只能新建。
2. **但已有文件可以用 Yjs 协同通道直接改**，已实测打通：socket.io 命名空间 `/texhub`、
   挂载路径 `/sync`（**不是** `/socket.io`）、线路格式就是标准 Yjs sync 协议
   （`MessageSync = 0`，`ws_action.ts` `messageListener` 完整支持）。
   用 `tools/texhub-yjs.mjs read|write|append` 操作。
   **服务端没有任何回执协议**（不存在 `sync:ack`），落库只能靠「回读 + 编译后
   `GET /tex/file/download`」双通道 SHA256 比对。
   全量覆盖写前**必须先确认服务端 doc 长度**，否则内容会翻倍。
   → [03-write](docs/texhub/03-write.md)
3. **响应永远是 HTTP 200**，成败看 body 里的 `resultCode`（成功为 `"200"`）。
   → [02-read](docs/texhub/02-read.md) 2.1
4. **`GET /tex/file/code` 会静默返回空串**给子目录文件（源码未拼接 `file_path`）。
   读子目录文件一律用 `GET /tex/file/download`。
   → [02-read](docs/texhub/02-read.md) 2.3

## 环境

- **线上站点**：`https://tex.poemhub.top`
- **协同 WebSocket**：`wss://socket.poemhub.top/texhub`（socket.io + Yjs）
- **本项目 ID**：`1ca9d4b0e5734ed1b5d122df09a265f4`
- **源码位置**：`E:\dolphin\texhub-ai`
- **refreshToken**：存本仓库 `env.md`（已 gitignore，**切勿提交**）
- **accessToken**：有效期仅 4 小时，每轮操作现取，用完即弃不落盘
  → [01-auth](docs/texhub/01-auth.md)

## 本项目（裁员补偿计算说明）速记

- 主文件：`main.tex`（`main_flag=1`，**不可删**）
- 结构：`main.tex` 通过 `\input{sections/secNN-*.tex}` 装配 14 节，
  **新增节须同时在 `main.tex` 补 `\input`**
- 本地副本：`E:\dolphin\gd-fire\salary\`
- 图片路径：`\graphicspath{{./figure/}}`，但 `salary/` 下的 PNG 实际都在项目根目录，
  **本地可编译、传上服务端前需先建 `figure/` 并移入**，否则 `Missing $` 类错误

更完整的端点表、错误码表和操作准则见
[00-cheatsheet](docs/texhub/00-cheatsheet.md)。
