# 02 读文件

> 上游：[00-cheatsheet](00-cheatsheet.md)、[01-auth](01-auth.md)（先取到 token）。
> 本文讲**怎么把服务端的内容取回本地**。写入方向见 [03-write](03-write.md)。

## 2.1 统一响应包络 —— 必须检查 `resultCode`

`rust_wheel/.../actix_http_resp.rs`：**HTTP 状态码永远是 200**，业务结果在 body 里。

```json
{ "result": <T>, "statusCode": "200", "resultCode": "200", "msg": "ok" }
```

- 成功：`resultCode == "200"`
- 失败：`resultCode` 为错误码，`msg` 为中文/英文说明，HTTP 仍是 200

> 🔴 **AI 判据：不要用 HTTP 状态码判断成败，一律解析 `resultCode`。**
> 校验失败会得到 `001002D002`、`INVALID_FILE_NAME`、`RESOURCE_ALREADY_EXISTS`、
> `FILE_NOT_FOUND`、`UPLOAD_FILE_FAILED`、`001002P001`(超限)、`0030010016`(人机验证失败) 等。

例外：`/tex/ul/proj/upload` 在 zip 里找不到 `main.tex` 时会抛 actix 错误，
返回真正的 HTTP 500 `exact file failed`，**不在包络里**。

## 2.2 核心数据模型：`file_id` 与 `parent`

树形结构由两个字段表达，**不是路径字符串**：

| 字段 | 含义 |
|---|---|
| `file_id` | 本节点唯一 ID（32 位 hex，无连字符），**所有单文件接口的主键** |
| `parent` | 父节点的 `file_id`；**顶层节点的 `parent` 直接等于 `project_id`** |
| `file_path` | 该节点所在**目录**的相对路径（不含文件名），根目录为 `"/"` |
| `file_type` | `0` = 文件夹，`1` = .tex 文件（`ThFileType`） |
| `main_flag` | `1` = 主文件（`main.tex`），**禁止删除/移动** |
| `yjs_initial` | `0` = Yjs 协同文档尚未初始化 |

**物理路径** = `{compile_base_dir}/{project_id}/{file_path}/{name}`

### 2.2.1 🔴 项目根是虚拟的，没有对应记录

**`tex_file` 表里不存在"根目录"这一行。** 源码依据：

- `TexFileAdd::gen_tex_main` 建主文件时 `parent: prj_id`（= project_id）、`file_path: "/"`
- `get_file_tree(parent_id)` 直接 `filter(parent == parent_id)`

所以：

| 操作 | 正确传参 |
|---|---|
| 拉整棵树 | `?parent=<project_id>` |
| 在根目录建文件/文件夹 | `parent = <project_id>` |
| 在子目录建文件/文件夹 | `parent = <该目录的 file_id>` |

> 🔴 **不要去找"根目录的 file_id"——它不存在。** 网页端同样是
> `getFileTree(projectId)`（`ProjectTree.tsx` / `TreeFolderCreate.tsx`）。
> 若未选中任何节点时，UI 直接把 `parent` 设为 `pid`（见 `TreeFolderCreate.tsx`）。

`file_path` 取值规律（`get_file_path`）：

| 情形 | `file_path` |
|---|---|
| 根目录下的文件 | `"/"` |
| 根目录下的文件夹 `figures` | `"/figures"` |
| 上面文件夹内的文件 | `"/figures/xx.tex"` 的目录部分 `"/figures"` |

### 2.2.2 拉取文件树

```bash
curl -s -H "Authorization: Bearer $TEXHUB_TOKEN" \
  "$TEXHUB/tex/file/tree?parent=$TEXHUB_PROJ" | jq '.result'
```

`FileTreeResp` 递归结构（顶层元素的 `parent` = project_id）：

```json
[{ "name":"main.tex","file_id":"a1b2...","file_type":1,"file_path":"/",
   "parent":"1ca9d4b0e5734ed1b5d122df09a265f4","main_flag":1,"yjs_initial":1,"children":[]},
 {"name":"sections","file_id":"c3d4...","file_type":0,"file_path":"/sections",
   "parent":"1ca9d4b0e5734ed1b5d122df09a265f4","main_flag":0,"children":[
     {"name":"sec01-claims.tex","file_id":"e5f6...","file_type":1,
      "file_path":"/sections","parent":"c3d4...","main_flag":0,"children":[]}]}]
```

- `/tex/file/tree` — 全树（含文件与文件夹，递归 `children`）
- `/tex/file/folder/tree` — 仅文件夹，且会**额外包一层虚拟根节点**（`new_virtual_root`）
- `/tex/file/list?parent=` — 仅一层，不递归
- 辅助：`GET /tex/file/main?project_id=` 取主文件；`GET /tex/file/detail?file_id=` 取单个文件元信息（含 `nickname`）

## 2.3 ⚠️ `/tex/file/code` 只能读根目录文件

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$TEXHUB/tex/file/code?file_id=$FID" | jq -r '.result'
```

**源码事实**（`file_service.rs::get_text_file_code`）：

```rust
let file_folder    = format!("{}/{}", base_compile_dir, tex.project_id);
let file_full_path = format!("{}/{}", file_folder, tex.name);   // ← 没有拼接 file_path！
```

即**忽略了 `file_path`**。对 `sections/sec01-claims.tex` 会去读
`{base}/{proj_id}/sec01-claims.tex`（不存在）→ 返回**空字符串**，且不报错。

> 🔴 **推论：子目录文件一律不要用 `/tex/file/code` 读，会静默拿到空串。**

## 2.4 通用读法：`/tex/file/download`（二进制流）

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$TEXHUB/tex/file/download?file_id=$FID" -o out.tex
```

`get_path_content_by_fid` **正确拼接 `file_path` + `name`**，根目录与子目录都可用。
注意：

- 返回的是**文件原始字节**，不是 JSON 包络；需自行判断/捕获错误
- 要求调用者是项目协作者（`get_collar_relation`），否则 400 `lack of privilleage`

> ⚠️ **本接口尚未统一到包络风格**：非协作者拿到的是**真正的 HTTP 400** + `text/plain` 的
> `lack of privilleage`，而其余端点（`project/info`、`file/tree`、`file/detail` 等）
> 返回 HTTP 200 + `resultCode=0040010014` `PROJ_ACCESS_DENIED`。见
> [03-write](03-write.md) 3.6.7。
- 图片等二进制同样适用

## 2.5 整项目拉取（推荐用于备份/全量对比）

```bash
curl -s -X PUT -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"project_id":"'"$TEXHUB_PROJ"'","version":""}' \
  "$TEXHUB/tex/project/download" -o proj.zip
```

返回 `application/zip`。**一次拿到整棵树**，是最可靠的"服务端最新文档"获取方式。
（`PUT /tex/project/compress` 只压缩落盘返回路径，不回传文件。）

## 2.6 Yjs 通道读（可选，与 REST 结果一致）

需要读协作态（如看别人正在编辑的实时内容、或读尚未 flush 的内存内容）才用。
协议细节与脚本用法见 [03-write](03-write.md) 第 3.6 节。

实测：10 个文件同时走 REST `/tex/file/download` 与 Yjs 通道读取，**10/10 字节完全一致**。
所以**日常同步用 REST 即可**，不必依赖不稳定的 WebSocket。
