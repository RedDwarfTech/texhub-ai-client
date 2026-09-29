# 04 文件与文件夹管理

> 上游：[00-cheatsheet](00-cheatsheet.md)、[01-auth](01-auth.md)。
> 本文讲**增删改名、目录操作**。带内容的写入见 [03-write](03-write.md)。
> 字段含义（`file_id` / `parent` / `file_path`）见 [02-read](02-read.md) 2.2。

## 4.1 新建空文件 / 文件夹

```bash
# .tex 文件
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"sec12-new.tex","parent":"'"$TEXHUB_PROJ"'","project_id":"'"$TEXHUB_PROJ"'","file_type":1}' \
  "$TEXHUB/tex/file/add" | jq -r '.result.file_id'

# 文件夹（同样是 /tex/file/add，改 file_type 为 0）
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"figures","parent":"'"$TEXHUB_PROJ"'","project_id":"'"$TEXHUB_PROJ"'","file_type":0}' \
  "$TEXHUB/tex/file/add" | jq .
```

`file_type`：`0` = 文件夹，`1` = .tex 文件。

> ⚠️ `POST /tex/project/folder` 的 `TexFolderReq` **只有 `folder_name` / `proj_type` /
> `default_folder`，没有 `project_id`** —— 它建的是**项目列表页的收藏夹**，不是项目内目录。
> **项目内建目录必须用 `POST /tex/file/add` 且 `file_type: 0`。**

> `POST /tex/file/add` 建的是**空文件**。要带内容，见
> [03-write](03-write.md) 3.2（`/tex/ul/file/upload`）。

## 4.2 文件名校验（`POST /tex/file/add` 会强制）

允许：`a-z A-Z 0-9 _ - .` 及**中日韩汉字**（U+4E00–U+9FFF）。
禁止：**空格**、括号、`%`、`/` 等一切其他符号；不可为 `.` 或 `..`；≤255 字符。

> 🔴 本项目的 `IMG_0202.PNG`、`截屏 2026-09-27 10.55.35-调休和年假.png`、
> `去年项目奖金.PNG`、`重庆光大网络技术有限公司_打卡时间_....xlsx`
> **含空格与中文以外的标点/长串，多数无法通过校验**。这类证据图片不要尝试上传，
> 保持在本地 `salary/` 目录即可（正文的 `\graphicspath` 也只指向 `./figure/`）。

## 4.3 重命名 / 移动 / 删除

```bash
# 重命名：legacy_name 必填，用于乐观校验
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"file_id":"'"$FID"'","name":"new.tex","legacy_name":"old.tex"}' \
  "$TEXHUB/tex/file/rename" | jq -r '.resultCode'

# 移动：dist_file_id = 目标文件夹 file_id
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"project_id":"'"$TEXHUB_PROJ"'","file_id":"'"$FID"'","dist_file_id":"'"$DEST_FID"'"}' \
  "$TEXHUB/tex/file/mv" | jq -r '.resultCode'

# 删除（主文件禁删；文件夹递归删）
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"file_id":"'"$FID"'"}' "$TEXHUB/tex/file/del" | jq -r '.resultCode'
```

约束与注意：

- 单项目文件数上限 **1000**（`add_file` 检查，超出报 `001002D001`）。
- 主文件（`main_flag=1`）**禁止删除/移动**，删除会返回 `delete_main_forbidden`。
- 删文件夹是**递归删**（`delete_file_recursive`），子节点全部变孤儿。
- 删除会让该文件的 **Yjs 协同历史丢失**，`texhub-broadcast` 的 `deletion_audit`
  会留下"完全删除"记录。
- 🔴 **破坏性操作，先与用户确认再执行。**

## 4.4 常用错误码

| `resultCode` | 含义 |
|---|---|
| `delete_main_forbidden` | 试图删除/移动主文件 |
| `INVALID_FILE_NAME` | 文件名含非法字符（见 4.2） |
| `RESOURCE_ALREADY_EXISTS` | 同级同名（`UNIQUE(parent,name,file_type)`） |
| `FILE_NOT_FOUND` | `file_id` 不存在 |
| `001002D001` | 单项目文件数超 1000 |
| `001002D002` | 文件名校验失败 |
| `001002P001` | 超出大小限制（上传 1MB / zip 100MB） |
| `UPLOAD_FILE_FAILED` | 上传事务回滚（常见于同名冲突） |
| `lack of privilleage` | 不是该项目协作者（`get_collar_relation` 失败） |
| `0030010009` | 数据不存在（refreshToken 查不到时也用它） |
| `0030010016` | 人机验证失败（仅登录接口） |
