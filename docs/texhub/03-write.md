# 03 写文件

> 上游：[00-cheatsheet](00-cheatsheet.md)、[01-auth](01-auth.md)。
> 本文讲**怎么把内容写进服务端**。文件增删改名见 [04-manage](04-manage.md)，
> 取回内容见 [02-read](02-read.md)。

## 3.1 平台的核心限制（先读这段）

### 两套存储

| 存储 | 位置 | 谁读它 | 谁写它 |
|---|---|---|---|
| **磁盘** | `{compile_base_dir}/{proj_id}/...` | xelatex 编译器 | `POST /tex/ul/file/upload`、zip 解压、Yjs flush |
| **Yjs/PG** | Postgres + LevelDB | **网页编辑器** | 仅 WebSocket 协同 |

`/tex/file/ver/add` **只往 `tex_file_version` 历史表插一行**，不碰磁盘、不碰 Yjs。

### 各写入端点能力实测

| 端点 | 落盘 | 建 DB 行 | 初始化 Yjs | 能改已有文件 |
|---|---|---|---|---|
| `POST /tex/file/add` | ✅ 建**空文件** | ✅ | ❌ | ❌ |
| `POST /tex/ul/file/upload` | ✅ **写内容** | ✅ | ❌ | ❌ |
| `POST /tex/ul/proj/upload` | ✅ 解压全量 | ✅ 建新项目 | ❌ | ❌（产生**新** project\_id） |
| `POST /tex/file/ver/add` | ❌ | ❌ | ❌ | 仅历史快照 |

> 🔴 **结论：公开 REST API 没有"更新已有文件内容"的接口。**
> `/tex/file/ver/add` 名字像 save，实际只是历史版本快照，别误用。
> 要改已有文件，走本文 3.6 节的 Yjs 通道。

### 选型决策

| 你要做的事 | 用什么 |
|---|---|
| 改 `main.tex` 等**已有文件** | Yjs 通道（3.6），不新建 `file_id`、不丢历史 |
| **新增**章节文件 | `POST /tex/ul/file/upload` + Yjs 补 `\input` |
| 整项目重建 | `/tex/ul/proj/upload`（兜底，会丢协作关系与历史） |
| 删除后重传 | 仅用户明确接受代价时（3.4） |

## 3.2 上传新文件（带内容）

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -F "project_id=$TEXHUB_PROJ" \
  -F "parent=$TEXHUB_PROJ" \   # 顶层文件的 parent 就是 project_id
  -F "file=@sections/sec11-overtime-pending.tex" \
  "$TEXHUB/tex/ul/file/upload" | jq .
```

- multipart 字段：`file`（**可重复**，`files: Vec<TempFile>`）、`project_id`、`parent`
- 单文件上限 **1 MB**（`total_limit(1048576)`，且 `tmp_file.size > 1MB` 再拒一次）
- 落盘路径用 **parent 的 `file_path`**；新记录 `file_path` 也等于 parent 的 `file_path`
- `parent` 传文件夹的 `file_id` 即可上传进子目录
- **无幂等**：`tex_file` 上有 `UNIQUE (parent, name, file_type)`（`tex-20241007134426.sql:1449`），
  `create_proj_file_impl` 是裸 `INSERT`，重名直接**唯一约束冲突**，整个事务回滚、返回
  `UPLOAD_FILE_FAILED`。**同名必须先删后传。**

## 3.3 上传整个项目（zip）

```bash
zip -r proj.zip main.tex sections/
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -F "file=@proj.zip" "$TEXHUB/tex/ul/proj/upload" | jq .
```

- 必须是 `.zip`（服务端按扩展名校验，非 zip 报 `UnexpectFileType`）
- zip 内**必须含 `main.tex``，`find_file_path` 会**递归查找**；找不到直接返回
  HTTP 500 `exact file failed`（不是包络里的 `resultCode`，注意这里会抛 actix 错误）
- 若 zip 内有**多个** `main.tex`，取**第一个**作为项目根
- **项目名 = zip 文件名去掉扩展名**（`file_stem`），想好命名再传
- 上限 100 MB
- 配额：非 VIP 最多 2 个项目，VIP 最多 50 个
- **产生全新的 `project_id`**，与原项目的协作关系、分享链接、历史**全部无关**

## 3.4 「删除后重传」策略与其代价

```bash
# 1) 删（主文件会被拒：resultCode=delete_main_forbidden）
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"file_id":"'"$FID"'"}' \
  "$TEXHUB/tex/file/del" | jq -r '.resultCode'

# 2) 重传
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -F "project_id=$TEXHUB_PROJ" -F "parent=$PARENT_FID" \
  -F "file=@new.tex" "$TEXHUB/tex/ul/file/upload" | jq -r '.resultCode'
```

代价（务必先与用户确认）：

- **`file_id` 会变**（每次 `Uuid::new_v4()`）→ 所有 `parent` 指向它的子节点**全部变成孤儿**，
  文件树错乱。删文件夹更是递归删（`delete_file_recursive`）。
- 该文件 **Yjs 协同历史丢失**，`/tex/project/history/*` 与 `texhub-broadcast` 的
  `deletion_audit` 会留下"完全删除"记录。
- **`main.tex` 删不掉**（`main_flag == 1` 直接拒），所以主文件无法用此法更新。
- 多人同时在线编辑时，删掉对方正在编辑的 doc 会导致其编辑器异常。

## 3.5 上传内容后网页可能显示空白

`gen_upload_tex_file` 固定写 `yjs_initial: 0`。磁盘已有内容，但 Yjs doc 未播种，
网页编辑器读的正是 Yjs doc → **可能打开是空白**。
播种接口 `POST /doc/initial` 属于**内网服务** `texhub-broadcast`（非 `tex.poemhub.top` 暴露），
公网不可达。

> 🔴 因此「上传成功」≠「网页里看得到」。**同步后务必在网页上人工确认一次。**

## 3.6 唯一真正的"编辑"通道：Yjs WebSocket ✅ 已打通

网页编辑器的每次按键都走
`socket.io` → `texhub-broadcast` → Yjs doc（docId = `file_id`）。
好消息：**协议就是标准 Yjs sync 协议，可以用 Node.js 直接驱动，无需浏览器。**

### 3.6.1 连接参数（已实测）

| 项 | 值 | 来源 |
| --- | --- | --- |
| 命名空间 | `https://socket.poemhub.top/texhub` | `config-pro.ts` → `socketUrl` |
| engine.io 挂载路径 | `/sync` ⚠️ **不是** `/socket.io` | 实测 `/socket.io/` 返回 404 |
| transport | `["websocket","polling"]` + `tryAllTransports: true` | 只给 `["websocket"]` 会 `connect_error: timeout` |
| query `docId` | `file_id`（**UUID**，取自 `/tex/file/tree`，勿用 `project/info` 的 snowflake） | `server_setup_ws.ts` |
| query `projId` | `project_id` | 同上 |
| query `docType` | `1` = TEX，`2` = PROJECT | `tex_file_type.ts` |
| query `access_token` | JWT | `auth.ts` |
| 文本名 | `ydoc.getText(docId)` | `yjs_utils.ts:128` |

### 3.6.2 线路格式

标准 Yjs sync，外层再包一个 `varuint(MSG_SYNC=0)`：

```
varuint(0)  varuint(子类型)  <payload>
子类型 0 = SyncStep1   varUint8Array(stateVector)
子类型 1 = SyncStep2   varUint8Array(update)
子类型 2 = Update      varUint8Array(update)
```

服务端 `messageListener` 先 `readVarUint` 剥掉外层 0，再交给
`syncProtocol.readSyncMessage`。所以**任何标准 Yjs 库都能互通**，
不需要任何 TeXHub 私有格式。

### 3.6.3 落库确认：**没有 ACK 协议**

⚠️ 早期版本的本节曾描述一个 `sync:ack_req` / `sync:ack` / `sync:nack` 协议，**那是错的**。
2026-09-28 全仓检索（`rg "sync:ack|ack_req"`，排除 `node_modules`）在 `backend/texhub-broadcast`
里**零命中**，`ws_action.ts` 全文也没有任何 ack 相关逻辑。

`messageListener`（`ws_action.ts`）对 `MessageSync` 的处理只有三步：写回复类型 → `readSyncMessage`
→ 有话可说才回。**服务端不回执，也不报错**。

**因此：唯一的落库判据是回读比对。** 见 3.6.5.1。

顺带说明两条与落库相关的机制（都在源码里，读代码比猜协议可靠）：

- `closeConn`：最后一个连接断开时，若 `persistencePostgresql` 非空，会 `writeState(doc.name, doc)`
  后 `doc.destroy()` 并从 `docs` 删除。**即"断开即落盘并从内存卸载"**，
  所以每次重连都要重新从 PG 装载 —— 装载时机不确定，这解释了 3.6.5 的"有时有内容、有时为空"。
- 编译前 `flush_project_before_compile()` 会把 Yjs 刷到磁盘，**这是"内容真正落盘"的时机**。

### 3.6.4 可用脚本

`tools/texhub-yjs.mjs` —— 已实测连通：

```bash
# Windows（本仓库）
cd E:\dolphin\texhub-ai\backend\texhub-broadcast   # 借用其 node_modules
$env:TEXHUB_TOKEN = "<accessToken>"
$S = "E:\dolphin\gd-fire\tools\texhub-yjs.mjs"

node $S probe                            # 连通性自检
node $S read   --file <fileId>           # 读全文
node $S write  --file <fileId> --local main.tex   # 用本地文件覆盖全文
node $S append --file <fileId> --local sec.tex    # 追加
```

依赖版本需与 texhub-broadcast 一致：
`socket.io-client@4.8.4  yjs@13.6.33  y-protocols@1.0.7  lib0@0.2.117`

> ⚠️ `write` 是**整篇覆盖**。执行前脚本会打印服务端现状供人工确认。
> 多端同时在线时覆盖会丢改动，建议先 `read` 比对。

### 3.6.5 实测坑位

- **WebSocket 很不稳定**：11 个文件里首轮 7 个 `connect_error: timeout`，
  需重试 + 间隔退避（1.5s～3s 递增）。
- **socket.io 偶尔把二进制帧序列化成 `{type:'Buffer',data:[…]}`**，
  直接 `new Uint8Array(raw)` 会得到**长度 0** 并在解码时静默抛错。
  必须归一化：依次处理 `Uint8Array` / `ArrayBuffer` / `Buffer` /
  `Array` / `{data:[…]}`。
- `main.tex`（`main_flag=1`）用 UUID 作 `docId` 时，**服务端是否回 step2 差量不确定**：
  2026-09-28 实测同一 `file_id` 连两次，第一次只收到 step1（doc 长度 0），
  第二次收到 step1 + step2（doc 长度 2185）。根因见 3.6.3 的 `closeConn`：
  断开即从内存卸载、重连重新装载，装载时机不确定。
  换 snowflake 则稳定连到空文档。**`main.tex` 不要用 `tools/texhub-yjs.mjs` 的
  `connectAndSync` 流程**（它硬等 step2，必然 20s 超时抛错）。
- ⚠️ `/tex/project/info` 里的 `main_file.id`（如 `550039160300240896`）是
  **另一个 snowflake 整数 id**，来自 `get_uniq_id()`。它不是 `file_id`，
  拿它当 `docId` 会连到一个**空文档**（实测 state vector 仅 4 字节）。
  **Yjs 的 `docId` 一律用 `/tex/file/tree` 给出的 UUID。**

### 3.6.5.0 🔴 全量覆盖写（`write`）的前置条件：必须先确认服务端 doc 长度

`write` 的实现是 `text.delete(0, len); text.insert(0, incoming)`。
若本地 Y.Doc **没有先和服务端同步过**（`text.length === 0`），它发出的 update 就是
"在位置 0 插入 N 个字符"，**服务端不会删除任何东西**：

- 服务端 doc 为空 → 结果正确（纯插入）；
- 服务端 doc 非空 → 结果是**内容翻倍**（旧内容 + 新内容），且不可逆。

2026-09-28 给 `main.tex` 补 `\input` 时走了这条路，安全做法是
**先开一个只读 session 打印 `text.length`，确认服务端长度后再决定**：

```js
const before = await session("read", null);          // 只读，打印 doc 长度
if (before !== 0) { /* 不可盲插：需先真正同步，或改走删除后重传 */ }
await session("write", (text) => {                  // 同一脚本内再开一个 session
  const doc = text.doc;
  doc.transact(() => { if (text.length) text.delete(0, text.length); text.insert(0, content); }, "ai");
});
```

`before !== 0` 时的两条出路：① 等到收到 step2（doc 长度变为服务端长度）后再覆盖；
② `DELETE /tex/file/del` + `POST /tex/ul/file/upload`（见 3.4，仅适用于非主文件）。

> 参考实现：2026-09-28 用的 `write-nowait.mjs`（不硬等 step2，两轮 session）。

### 3.6.5.1 🔴 `tools/texhub-yjs.mjs` 的 `sync:ack` 判定是失效的

`waitAck()` 监听的是一个**服务端根本不存在的协议**（见 3.6.3）。
因此 `write` 每次都会在 15 秒后报 `未确认：等待 sync:ack 超时`，
**即使写入其实已经成功**。

2026-09-28 实测：`write` 报超时，但紧接着重连 `read` 到的服务端现状
已是新内容（1256 → 905 字符），且 `GET /tex/file/download` 在编译 flush
后也拿到了新内容。**所以这个超时不能当作写入失败。**

> 替代验证办法（两条独立通道都对上才算成功）：
> 1. 重连后 `read --file <id>` → 与预期内容做 SHA256 比对；
> 2. 触发一次编译（编译前会自动 flush Yjs → 磁盘），
>    再 `GET /tex/file/download?file_id=` 与预期内容做 SHA256 比对。
>
> ⚠️ 通道 1 单独**不足以定论**：3.6.5 已记录重连时服务端可能返回空 doc，
> 此时读到 0 长度可能是"没写进去"，也可能是"还没装载完"。**以通道 2 为准。**
>
> 根治办法：删掉 `waitAck()`，直接以通道 2 为成功判据。

### 3.6.5.2 🔴 PowerShell 重定向会破坏 node 的 UTF-8 stdout

用 PowerShell 5.1 的 `node yjs.mjs read --file <id> > out.txt` 存盘，
会先按控制台编码（默认 GBK）解码 node 的 UTF-8 输出、再转存，
**中文全部变乱码且字节数虚增**（同一份 2044 字节的文件被存成 2994 / 2606 字节），
据此做的 SHA256 比对会得出「Yjs 与 REST 不一致」的**假结论**。

正确做法是让 cmd 做**裸字节重定向**，不要经过 PowerShell 的文本管道：

```powershell
cmd /c "cd /d <模块所在目录> && node yjs.mjs read --file <id> > out.txt 2>nul"
```

设置 `[Console]::OutputEncoding = [Text.Encoding]::UTF8` 只能缓解控制台显示，
**不能**修复落盘文件，必须用上面的 `cmd /c`。

> 本机 `E:\dolphin\texhub\backend\texhub-broadcast\node_modules` 与
> `E:\dolphin\texhub-ai\backend\texhub-broadcast\node_modules` 里的
> `yjs` / `socket.io-client` / `lib0` 都是**失效的 pnpm 软链**（junction 目标不存在），
> 借用它们会 `Cannot find module`。需自行 `npm i socket.io-client@4.8.4 yjs@13.6.33
> y-protocols@1.0.7 lib0@0.2.117` 到一个真实目录，再把脚本拷进去运行。

### 3.6.6 ✅ 安全：握手鉴权 + 文档级归属校验均已生效（2026-09-30 双账号交叉实测）

**结论：Yjs 通道的越权读写已修好。** 用两个真实账号（`env.md` 里的账号1/账号2，
`userId` 分别为 103 / 104）做交叉测试，账号2 拿账号1 的 `docId` **读不到任何内容**。

探针：连上后发 `SyncStep1`，收集 8s 内的帧（临时脚本，未入库）。

| 场景 | 结果 |
| --- | --- |
| 无 token | `connect_error: auth token is missing` ❌ 拒连 |
| 伪造 token | `connect_error: invalid access token` ❌ 拒连 |
| 有效 token + 本人 `docId` | 握手通过，`docLen=2586` ✅ 读到正文 |
| 有效 token + **账号1 的 `docId`（账号2 身份）** | 握手通过，随即 `io server disconnect`，**零帧下发** ❌ |
| 有效 token + 不存在的 `docId` | 同上，`io server disconnect`，零帧 |

关键对照：同一个 `docId`，账号1 的 token 能读到 2586 字符，账号2 的 token 一帧都收不到
（3 轮复现稳定）。说明服务端在 `setupWSConnection` 里**按 token 的 `userId` 校验了
`docId` 的归属**，不是仅校验 token 真伪。

> 历史记录（已失效，保留备查）：2026-09-27 曾实测无 token 也能握手并正常收发 Yjs 帧，
> 当时判定为高危缺陷。`file_id` 是 UUID v4（122 bit 随机熵，不可枚举）这一点仍然成立。

### 3.6.7 ✅ REST 侧的元数据越权读也已修复（2026-09-30 复测）

此前（见本轮修复前）账号2 读账号1 的项目时，`project/info`、`file/tree`、`file/detail`
都返回 `resultCode=200` 与完整数据——**97 个节点的目录树、文件名、路径、`user_id` 全部可见**，
只有 `file/download` 正确返回 400 `lack of privilleage`。

**现已统一拦截。** 账号2 (userId 104) 读账号1 (userId 103) 的项目 `e5deffb89…`：

| 端点 | 修复前 | 修复后 |
| --- | --- | --- |
| `GET /tex/project/info` | 200 + 完整数据 | `0040010014` |
| `GET /tex/file/tree` | 200 + **97 节点**全树 | `0040010014` |
| `GET /tex/file/detail` | 200 + 文件名 / `user_id` / 时间戳 | `0040010014` |
| `GET /tex/file/code` | 200 | `0040010014` |
| `GET /tex/file/list` | 200 | `0040010014` |
| `PUT /tex/project/download` | 200 + 整项目 zip | `0040010014` |
| `GET /tex/file/download` | 400 `lack of privilleage` | 400（未变） |

新增错误码：

| 字段 | 值 |
| --- | --- |
| `resultCode` | `0040010014` |
| `result` | `"PROJ_ACCESS_DENIED"` |
| `msg` | `无权访问该项目` |

⚠️ 两个读代码时的坑：

1. **`result` 是字符串而非对象。** 它恒为真值，`if (resp.result)` 判断会**误判为成功**。
   必须看 `resultCode`。
2. **`file/download` 没跟上，仍是老风格。** 它返回真正的 HTTP 400 + `text/plain` 的
   `lack of privilleage`，**不在包络内**（其余端点都是 HTTP 200 + 包络）。两处不一致。

对照组：账号1 本人访问上述全部端点仍为 `resultCode=200`，确认不是服务整体异常。

## 3.7 内部服务（公网不可达，仅供理解架构）

`texhub-broadcast`（Node/Express，socket.io）：

| 端点 | 用途 |
|---|---|
| `POST /doc/initial` | 用磁盘内容播种 Yjs doc（`{doc_id,project_id,file_content}`） |
| `POST /doc/flush/project` | 强制项目内文件刷盘（编译前调用） |
| `POST /doc/flush/history` | 刷新历史快照（查看历史前调用） |
| `GET /doc/version/proj/scroll?projId=` | 项目版本滚动分页 |
| `GET /doc/version/file/scroll?fileId=` | 单文件版本列表 |
| `GET /doc/audit/full-deletions?docName=&days=` | 完全删除审计 |

`redis_stream` 经 `y_websocket_client.rs` 调用，公网**不要**尝试。

## 3.8 推荐的同步流程（改已有文件）

1. 取新 token（[01-auth](01-auth.md) 1.2）。
2. `GET /tex/file/tree?parent=$TEXHUB_PROJ` 找到目标 `file_id`（[02-read](02-read.md) 2.2.2）。
3. `GET /tex/file/download?file_id=$FID` 拉回服务端现状，存到临时文件。
4. 本地改这个临时文件。
5. `node tools/texhub-yjs.mjs read --file $FID` 再确认一次服务端现状（尤其多人在线时）。
6. `node tools/texhub-yjs.mjs write --file $FID --local <改好的文件>`，等 `sync:ack`。
7. 触发编译（[05-compile](05-compile.md)），在网页上看一眼确认内容正确。
