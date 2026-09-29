# 05 编译

> 上游：[00-cheatsheet](00-cheatsheet.md)、[01-auth](01-auth.md)。
> 本文讲**触发编译、查状态与日志、取 PDF**。

## 5.1 触发编译（用 `/compile/queue`，不要用 `/compile`）

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"project_id":"'"$TEXHUB_PROJ"'"}' \
  "$TEXHUB/tex/project/compile/queue" | jq .
```

返回体里就有轮询所需的 `id`（即 `qid`）与 `version_no`：

```json
{"id":5857,"comp_status":0,"version_no":550613203814449152,
 "comp_result":-1,"estimated_compile_time":29290}
```

`comp_status`：`0`=排队 `1`=编译中 `2`=完成；`comp_result`：`0`=成功。

### 🔴 `PUT /tex/project/compile` 是个陷阱

这个接口**存在、也返回 `resultCode:"200"`，但不会产生新产物**。
它走 `compile_project()` → `render_request()`，把请求转发给**内网**的
`{render_api_url}/render/compile/v1/project`；该服务在本部署里对公网调用
返回空 `result`，于是 `box_actix_rest_response(None)` 照样给你 200。

**实测（2026-09-28）**：连续调它 3 次、每次都 `resultCode=200`，
但编译日志与 PDF 始终停留在上一次（改动前）的内容，
`GET /tex/project/latest/pdf` 的 `?v=` 参数也不变。
差点据此误判"已编译通过"。

而 **`POST /tex/project/compile/queue` 才是真正干活的**：

1. 查是否已有 `Waiting`/`Compiling` 的队列，有则返回 `CompilingPocessing`；
2. **`flush_project_before_compile()`** —— 强制把 Yjs 刷到磁盘；
3. 插入 `tex_comp_queue` 记录，拿到 `id` / `version_no`；
4. 投递 Redis Stream，交给 `tex-render` 消费。

> 顺带纠正 5.2：**flush 发生在 `add_compile_to_queue()` 里**
> （`project_service.rs:1323`），所以「编译一次就会落盘」这句话
> 只对 `/compile/queue` 成立。

> 编译是**"网页编辑 → 磁盘"的唯一落地时机**。改完内容不编译，
> 磁盘上还是旧的 —— 但**必须用 5.1 的队列接口**去编译。

## 5.2 查状态

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$TEXHUB/tex/project/queue/status?id=$QUEUE_ID" | jq .
```

一般 30 秒上下，轮询到 `comp_status==2` 即可。

## 5.3 查日志

```bash
# 完整日志
curl -s -H "Authorization: Bearer $TOKEN" \
  "$TEXHUB/tex/project/compile/log?project_id=$TEXHUB_PROJ&version_no=0&file_name=main.tex&qid=0" \
  | jq -r '.result'
```

> 🔴 **必传 4 个 query 参数**，`TexCompileQueueLog`
> （`texhub-server/src/model/request/project/tex_compile_queue_log.rs:3-6`）
> 四个字段都是非 Option，缺一个就报
> `Query deserialize error: missing field ...`：
>
> ```
> ?project_id=<projId>&version_no=0&file_name=main.tex&qid=0
> ```
>
> `version_no` / `file_name` / `qid` 实际**都是摆设**：
> `get_compiled_log()`（`project_service.rs:1420-1438`）只按 `project_id`
> 读 `{main_file_name}.log`，其余字段从不使用，填 0 即可。
>
> ⚠️ 但**日志是按 `project_id` 覆盖写的旧文件**，编译没真跑时它不会变。
> 所以判断"编译是否真的发生"要**看内容有没有变**（对比日志 hash 或首行时间戳），
> 不能只看接口返回 200。首行形如
> `This is XeTeX, ... 28 SEP 2026 09:40`，时间戳即本次编译时刻。
>
> - 实时日志用 SSE：`GET /tex/project/compile/log/redis`
>   （EventSource 不能设 header，故用 `?access_token=`，见 [01-auth](01-auth.md) 1.3）

## 5.4 取 PDF

```bash
# 换 6 小时有效的签名 URL
curl -s -H "Authorization: Bearer $TOKEN" \
  "$TEXHUB/tex/file/pdf/preview-url?proj_id=$TEXHUB_PROJ" | jq -r '.result'
```

拿到形如 `/tex/file/pdf/preview?proj_id=…&signature=…&expire=…&access_key=103`
的**相对路径**，要拼上域名再取：

```powershell
Invoke-WebRequest -Uri ("https://tex.poemhub.top" + $u) -OutFile main.pdf
```

> 🔴 **不要**用 `GET /tex/project/latest/pdf` 返回的 `path` 去拼 URL。
> 它给的 `/2026/9/<projId>/main.pdf?v=<snowflake>` 是**静态目录路径**，
> 公网不在这台服务上，会 fallback 到 SPA 首页并返回一段 HTML
> （实测 2411 字节的 `<!DOCTYPE html>`，magic `3C 21 44 4F 43 54`）。
> 认 magic 是不是 `%PDF-` 就能发现。

### 校验渲染结果（模型读不了 PDF 时）

服务端 PDF 的 CJK 字体是子集化的，`pypdf` 抽出来的中文全是乱码，
**别拿它判断对错**。用 `pymupdf` 抽（ToUnicode CMap 处理正确）：

```python
import pymupdf
doc = pymupdf.open("main.pdf")
open("p2.txt", "w", encoding="utf-8").write(doc[1].get_text("text"))
```

再把 txt 落盘后用 read 工具看，能逐行核对表格列数与脚注内容。

## 5.5 架构备注

编译是**异步**的：投递到 Redis Stream，由 `tex-render` 消费（`cv-render`）。
所以触发接口立即返回，产物要轮询 5.2 或看 5.3 的日志。

