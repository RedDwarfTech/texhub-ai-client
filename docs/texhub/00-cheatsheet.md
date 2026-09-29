# TeXHub 三十秒速查

> 本文是**每次操作都要看**的一层。只够判断「该调哪个端点、该翻哪份文档」，
> 不含实现细节。所有端点、参数、字段均已对照源码核实。
> 核实基准：`E:\dolphin\texhub-ai\backend\texhub-server`（Actix-Web 主 API）、
> `backend/texhub-broadcast`（Yjs 协同）、`backend/infra-server`（登录鉴权）、
> `frontend/texhub-web/src/config/app/config-pro.ts`（线上配置）。

## 端点地图

| 目的 | 方法 | 路径 | 关键参数 | 详见 |
|---|---|---|---|---|
| **refreshToken 换 accessToken** | POST | `/infra/auth/access-token/refresh` | `refresh_token,grant_type`（**免 cfToken**） | [01-auth](01-auth.md) |
| 登录拿 token | POST | `/infra/user/login` | `phone,password,appId,deviceId,cfToken` | [01-auth](01-auth.md) |
| 列项目 | GET | `/tex/project/list` | — | [01-auth](01-auth.md) |
| 项目信息（含主文件名） | GET | `/tex/project/info` | `project_id` | [01-auth](01-auth.md) |
| 文件树 | GET | `/tex/file/tree` | `parent`（顶层传 **project_id**） | [02-read](02-read.md) |
| 读文件内容 | GET | ⚠️ `/tex/file/code` | `file_id`（**仅根目录文件**） | [02-read](02-read.md) |
| 读文件内容（通用） | GET | `/tex/file/download` | `file_id`（**返回二进制流**） | [02-read](02-read.md) |
| 整项目下载(zip) | **PUT** | `/tex/project/download` | body `project_id,version` | [02-read](02-read.md) |
| 新建空文件 | POST | `/tex/file/add` | `name,parent,project_id,file_type` | [03-write](03-write.md) / [04-manage](04-manage.md) |
| **上传带内容的新文件** | POST | `/tex/ul/file/upload` | multipart: `file[]`,`project_id`,`parent` | [03-write](03-write.md) |
| **上传整个项目(zip→新项目)** | POST | `/tex/ul/proj/upload` | multipart: `file[]` | [03-write](03-write.md) |
| **改已有文件内容** | socket.io | ✅ `/texhub` + Yjs | `tools/texhub-yjs.mjs` | [03-write](03-write.md) |
| 重命名 | PATCH | `/tex/file/rename` | `file_id,name,legacy_name` | [04-manage](04-manage.md) |
| 移动 | PATCH | `/tex/file/mv` | `project_id,file_id,dist_file_id` | [04-manage](04-manage.md) |
| 删除 | DELETE | `/tex/file/del` | `file_id`（主文件禁删） | [04-manage](04-manage.md) |
| 触发编译 | POST | `/tex/project/compile/queue` | `project_id` → 返回 `id`(qid)+`version_no` | [05-compile](05-compile.md) |
| 编译状态 | GET | `/tex/project/queue/status` | `id` | [05-compile](05-compile.md) |
| 编译日志 | GET | `/tex/project/compile/log` | `project_id,version_no,file_name,qid`（四项必填，后三项填 0 即可） | [05-compile](05-compile.md) |

## 最关键的约束

1. **公开 REST API 无法修改已有文件的内容**。`/tex/file/ver/add` 只写历史快照，不改文档；
   `/tex/ul/file/upload` 因 `UNIQUE(parent,name,file_type)` 约束只能新建。
2. **但已有文件可以用 Yjs 协同通道直接改**，已实测打通：socket.io 命名空间 `/texhub`、
   挂载路径 `/sync`（**不是** `/socket.io`）、线路格式就是标准 Yjs sync 协议
   （`MessageSync = 0`，`ws_action.ts` 的 `messageListener` 完整支持）。
   用 `tools/texhub-yjs.mjs read|write|append` 操作。
   🔴 **服务端没有任何回执协议**——源码里搜不到 `sync:ack`/`ack_req`，
   该脚本的 ack 判定是**失效的**，`write` 必然超时但**写入其实已成功**；
   改用「Yjs read + `GET /tex/file/download` 双通道 SHA256 比对」确认，
   且**以编译后的 download 为准**，见 [03-write](03-write.md) 3.6.3 / 3.6.5.1。
   🔴 全量覆盖写（`write`）前**必须先打印服务端 doc 长度**：
   本地 doc 为空时发出的是"纯插入"，服务端非空就会**内容翻倍且不可逆**，
   见 [03-write](03-write.md) 3.6.5.0。
3. **响应永远是 HTTP 200**，成败看 body 里的 `resultCode`（成功为 `"200"`）。
4. **`GET /tex/file/code` 会静默返回空串**给子目录文件（源码未拼接 `file_path`）。
   读子目录文件一律用 `GET /tex/file/download`。
5. **`PUT /tex/project/compile` 不会真的编译**（转发到内网 render 服务，返回空 result 却照样给 200）。
   触发编译必须用 `POST /tex/project/compile/queue`；且判断"编译成功"要看
   **日志内容是否变化**，不能只看接口返回。见 [05-compile](05-compile.md) 5.1。

## 环境与常量

- **线上站点**：`https://tex.poemhub.top`
- **协同 WebSocket**：`wss://socket.poemhub.top/texhub`（socket.io + Yjs）
- **本项目 ID**：`1ca9d4b0e5734ed1b5d122df09a265f4`
- **源码位置**：`E:\dolphin\texhub-ai`（Windows；macOS 原为 `/Users/dolphin/Documents/GitHub/texhub-ai`）
- **refreshToken**：存本仓库 `env.md`（已 gitignore，**切勿提交**）；accessToken 有效期仅 4 小时，用完即弃

## 给 AI 的操作准则

1. **先换 token**：accessToken 只有 4 小时有效期。每轮操作**开始前**用 `env.md` 里的
   refreshToken 调 [01-auth](01-auth.md) 的刷新接口拿新 token，不要复用上一轮遗留的。
   拿到 401/440 先怀疑过期，而不是接口权限。
2. **先读后写**：任何写操作前先 `GET /tex/file/tree?parent=$TEXHUB_PROJ` 摸清现状。
3. **判成败看 `resultCode`**，不看 HTTP 码。
4. **改已有文件内容**：公开 REST 做不到，但 **Yjs 通道可以**（[03-write](03-write.md)）。
   按破坏性从低到高：
   - **优先用 Yjs 通道改 `main.tex` 等已有文件**，它不新建 `file_id`、不丢历史：
      `node tools/texhub-yjs.mjs write --file <fileId> --local <本地文件>`
      ⚠️ 但 `main.tex` 走该脚本会在 `connectAndSync` 硬等 step2 而超时（3.6.5），
      且**写前必须先确认服务端 doc 长度**（3.6.5.0）。
      事后以「编译后 `GET /tex/file/download` 的 SHA256」判定落库。
   - **新增独立文件**（如新章节 `sections/secNN-xxx.tex`）→ 也可全自动：
      ① 目录不存在则 `POST /tex/file/add`（`file_type:0`, `parent=$TEXHUB_PROJ`）建目录；
      ② `POST /tex/ul/file/upload` 带上 `parent=<目录 file_id>` 上传正文；
      ③ 用 Yjs 通道往 `main.tex` 补一行 `\input{...}`。
      ④ **上传后用 `GET /tex/file/download` 比对 SHA256**，
         确认落的是 **UTF-8 无 BOM**（`curl.exe -F` 直传本地文件最稳，
         别让 PowerShell 文本管道碰中文，否则会存成 GBK）。
   - **整项目 zip 上传为新项目** → 仅作兜底（会丢协作关系与历史）。
   - **删除后重传** → 仅在用户明确接受 `file_id` 变更 / 协同历史丢失时使用。
     主文件（`main_flag=1`）删不掉，此法对 `main.tex` 无效。
   - ⚠️ `write` 是整篇覆盖，**多端同时在线会丢改动**，务必先 `read` 比对。
5. **不要上传证据图片**（[04-manage](04-manage.md) 文件名限制），它们只存本地。
6. **上传后必须人工确认**：编译一次 + 在网页上看一眼，因为 Yjs 可能未播种
   （[03-write](03-write.md)）。
7. **不要把 token、密码写进任何文件**。refreshToken 只能留在已 gitignore 的 `env.md`；
   accessToken 用完即弃，不落盘。
   🔴 别用 `/infra/user/login` 反复重登以刷新 token——它要 cfToken，脚本过不去。
8. 子目录文件**不要**用 `/tex/file/code` 读（[02-read](02-read.md)），会静默返回空串。
9. 破坏性操作（删除、`/tex/ul/proj/upload` 产生新项目）**先确认再执行**。

## 本项目（裁员补偿计算说明）速记

- 项目 ID：`1ca9d4b0e5734ed1b5d122df09a265f4`
- 主文件：`main.tex`（`main_flag=1`，**不可删**）
- 结构：`main.tex` 通过 `\input{sections/secNN-*.tex}` 装配 14 节，
  **新增节须同时在 `main.tex` 补 `\input`**
- 本地副本：`E:\dolphin\gd-fire\salary\`
- 图片路径：`\graphicspath{{./figure/}}`，但 `salary/` 下的 PNG 实际都在项目根目录，
  **本地可编译、传上服务端前需先建 `figure/` 并移入**，否则 `Missing $` 类错误
