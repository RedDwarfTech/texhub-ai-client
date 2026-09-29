
## TeXHub客户端

TeXHub客户端是通过AI辅助编写TeXHub在线协作网站https://tex.poemhub.top/的项目。

## 上下文信息

TeXHub项目的代码在目录：E:\dolphin\texhub-ai

**操作 TeXHub 服务端前必读 `TEXHUB_API.md`**（本仓库根目录），它是薄索引；细节按任务拆分在 `docs/texhub/` 下，需要哪块再读哪块：

| 你要做的事 | 读哪份 |
|---|---|
| 查端点速查表、看操作准则 | `docs/texhub/00-cheatsheet.md` |
| 拿 token（refreshToken 换 accessToken，免 cfToken） | `docs/texhub/01-auth.md` |
| 拉文件树、取回文件内容、整项目下载 | `docs/texhub/02-read.md` |
| **改已有文件内容**（Yjs 通道）、上传新文件 | `docs/texhub/03-write.md` |
| 建目录、重命名、移动、删除 | `docs/texhub/04-manage.md` |
| 触发编译、查日志、取 PDF | `docs/texhub/05-compile.md` |

所有端点、参数与包络格式均已对照 texhub-server / texhub-broadcast / infra-server 源码核实。

其中四条最关键的约束（极易踩坑，务必先看）：

1. **公开 REST API 无法修改已有文件的内容**。`/tex/file/ver/add` 只写历史快照，不改文档；`/tex/ul/file/upload` 因 `UNIQUE(parent,name,file_type)` 约束只能新建。
2. **但已有文件可以用 Yjs 协同通道直接改**，已实测打通：socket.io 命名空间 `/texhub`、挂载路径 `/sync`（**不是** `/socket.io`）、线路格式就是标准 Yjs sync 协议（`MessageSync = 0`）。用 `tools/texhub-yjs.mjs read|write|append` 操作。**服务端没有回执协议**（源码中搜不到 `sync:ack`），落库以「回读 + 编译后 `GET /tex/file/download`」双通道 SHA256 比对为准；全量覆盖写前**必须先确认服务端 doc 长度**，否则内容会翻倍且不可逆。细节见 `docs/texhub/03-write.md` 第 3.6 节。这是改 `main.tex` 的首选方式——不新建 `file_id`、不丢协同历史，且不必麻烦用户去网页端粘贴。
3. **响应永远是 HTTP 200**，成败看 body 里的 `resultCode`（成功为 `"200"`）。
4. **`GET /tex/file/code` 会静默返回空串**给子目录文件（源码未拼接 `file_path`）。读子目录文件一律用 `GET /tex/file/download`。

另外，Yjs 通道目前**完全没有鉴权**（详见 `docs/texhub/03-write.md` 第 3.6.6 节）：无 token 也能握手，REST 则正确返回 401。`file_id` 是 UUID v4（122 bit 随机熵，**不可枚举**），所以拿到 `docId` 就能越权读写该文档，但无法批量拖库——属高危而非致命。这是平台自身的安全缺陷，已如实记录待修。

同步时另有两个已踩过的坑（详见 `docs/texhub/03-write.md` 第 3.6.5 节）：Yjs 的 `docId` 必须用 `/tex/file/tree` 返回的 UUID，用 `/tex/project/info` 的 `main_file.id`（snowflake）会连到空文档；且 WebSocket 很不稳定，日常同步优先用 REST `/tex/file/download`（实测与 Yjs 内容 10/10 一致）。

## 默认规则

* 【重要】不要提交任何敏感信息，例如敏感环境变量、密码、key
* 如果没有特殊说明，默认回答使用中文
* 编辑后将最新内容同步到TeXHub服务端并触发编译，读取编译日志，验证编译结果
* 操作 TeXHub 时**渐进式披露**：只读当前任务需要的那份文档，不要一次性全读 `docs/texhub/`
* 如果是 **Windows**（PowerShell 5.1）：源码路径 `E:\dolphin\texhub-ai`；
  调 TeXHub API 优先用 `Invoke-RestMethod`，`curl.exe` 需 `--ssl-no-revoke` 且会吞 JSON 双引号
