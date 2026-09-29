# 01 认证

> 上游：[00-cheatsheet](00-cheatsheet.md)。本文只讲**怎么拿到 token、怎么带上 token**。
> 读文件见 [02-read](02-read.md)，写文件见 [03-write](03-write.md)。

## 1.1 登录（**需 cfToken，脚本不可自动化 → 日常改用 1.2**）

```bash
curl -X POST 'https://tex.poemhub.top/infra/user/login' \
  -H 'Content-Type: application/json' \
  -d '{"phone":"<手机号>","password":"<密码>","appId":"n29Pa29WS1","deviceId":"<自定义设备ID>","cfToken":"<turnstile>"}'
```

响应（`result` 内）：

```json
{ "registerTime": 0, "refreshToken": "uuid", "accessToken": "eyJ...", "nickname": "..." }
```

字段名注意：请求体是**驼峰** `appId` / `deviceId` / `cfToken`（Rust 侧用 `#[serde(rename)]` 映射）。
`appId` 线上固定为 `n29Pa29WS1`。

> ⚠️ **`cfToken` 是 Cloudflare Turnstile 人机验证令牌，脚本无法自行生成。**
> 这是自动化登录的唯一障碍。**绕过办法见 1.2：用 `refreshToken` 换 token，该接口不校验 cfToken。**
> 拿不到 refreshToken 时才需要下面的手工路子：
> 1. 从浏览器 DevTools → Network 里抓一次真实登录请求，复制 `cfToken` 与 `accessToken`；
> 2. 复用浏览器 `localStorage` 中已存的 access token（键名 `x-access-token`，
>    见 `frontend/js-wheel/src/model/immutable/WheelGlobal.ts:4-5`，refreshToken 的键是 `x-refresh-token`）；
> 3. 登录响应 `result.refreshToken` 即为长期凭据，存进 `env.md`，之后一律走 1.2。
>
> 开发账号/口令目前硬编码在 `frontend/texhub-web/src/config/app/config-dev.ts`（`phone` / `password` 两项）。
> **本文不复制其值**，请从该文件读取。
> 补充：`turnstile_service.rs:121-138` 有两道旁路——`infra.captcha_enabled != "true"` 时直接放行，
> `CF_TURNSTILE_SECRET_KEY` 未配置时判失败。仓库 `settings.toml:10` 是 `captcha_enabled=false`。

## 1.2 ✅ 用 refreshToken 换 accessToken（**免人机验证，脚本首选**）

登录要 `cfToken`（Cloudflare Turnstile），脚本拿不到；但**刷新接口不需要**。
源码依据：`backend/infra-server/src/controller/user/auth_controller.rs:40`
（`#[post("/access-token/refresh")]`）的入参只有 `Json<AccessTokenRefreshReq>`，
无 `HttpRequest`、无 `cf_token` 字段；全仓库 `verify_turnstile_token` 仅在
`user_controller.rs:71`（`/infra/user/login`）与 `:147`（`/infra/user/login/email`）被调用。

```bash
curl -s -X POST 'https://tex.poemhub.top/infra/auth/access-token/refresh' \
  -H 'Content-Type: application/json' \
  -d '{"grant_type":"refresh_token","refresh_token":"<refreshToken>"}'
```

响应（`result` 内**只有** `accessToken`，不返回 refreshToken）：

```json
{ "result": { "accessToken": "eyJ..." },
  "statusCode": "200", "resultCode": "200", "msg": "ok" }
```

字段名是**下划线 snake_case**，与登录接口的驼峰 `appId/deviceId/cfToken` 风格相反，
极易写错。定义见 `infra-server/src/model/req/user/auth/access_token_refresh_req.rs:5-11`：

| 字段 | 必需 | 说明 |
|---|---|---|
| `refresh_token` | 是 | **明文** UUID v4（DB 里存的是 SHA-256 摘要，`user_controller.rs:110`） |
| `grant_type` | 是 | `#[validate(length(min=1))]` 只校验非空，**业务代码从不读取其值**（`auth_controller.rs:46` 只取 `refresh_token`），填 `"refresh_token"` 即可 |
| `scope` | 否 | 完全未使用 |

**不需要** `phone` / `appId` / `deviceId` / `cfToken` / `password`，也**不需要携带旧 accessToken**
（Traefik 已把该路径从 `jwt-token-auth` 中间件豁免：
`texhub-server/docs/deploy/ingressroute/texhub-web-route.yaml:60-68`）。

有效期与轮换：

- **accessToken 4 小时**（硬编码 `Duration::seconds(14400)`，
  `infra-server/src/composite/user/user_comp.rs:319`），claims 为
  `userId, deviceId, appId, lt, et, pid, exp`。
- **refreshToken 7 天，且滑动续期**：`auth_controller.rs:61-63` 每次刷新都调
  `update_refresh_token_exp_time` 把它推到 `now + 7 天`。
- ⚠️ 不轮换：旧 refreshToken 继续有效，表里的 `revoked_by_ip` / `revoked_date` / `replaced_by`
  字段（`dolphin_schema.rs:73-75`）**代码中从未写入**，无撤销机制。
- ⚠️ `query_refresh_token`（`oauth_service.rs:9-26`）的查询条件只有
  `refresh_token.eq(...)`，**没有 `expire_date` 过滤**，`oauth2_refresh_token` 表也无清理任务。
  即历史 token 只要 DB 记录还在就能无限期换取新 accessToken。

失败：refreshToken 查不到 → `resultCode = "0030010009"`（`InfraError::DataNotFound`），
HTTP 仍是 200。

> 🔴 **易踩的坑**：`/infra/auth/access_token/verify`（**下划线**，Traefik forwardAuth 专用）
> 与 `/infra/auth/access-token/refresh`（**连字符**，本接口）**是两个不同端点**。
> `auth_controller.rs:32` 的 utoipa 注解还错写成了下划线（`auth_controller.rs:40` 才是真路由），
> 别照着 Swagger 拼 URL。
> 另注：`POST /texpub/auth/access-token/refresh`（`texhub-web-route.yaml:46`）是
> `dolphin-post-service:11014` 的同路径接口，**不在本仓库**，对 TeXHub 是死路由。

### 1.2.1 本项目实测（Windows PowerShell）

refreshToken 存放于本仓库 `env.md`（已被 `.gitignore` 忽略，**切勿提交**）。

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$tk = (Invoke-RestMethod -Uri "https://tex.poemhub.top/infra/auth/access-token/refresh" `
        -Method Post -ContentType "application/json" `
        -Body (@{ grant_type = "refresh_token"; refresh_token = "<refreshToken>" } | ConvertTo-Json -Compress)
      ).result.accessToken
Invoke-RestMethod -Uri "https://tex.poemhub.top/tex/project/info?project_id=1ca9d4b0e5734ed1b5d122df09a265f4" `
  -Headers @{ Authorization = "Bearer $tk" } | Select-Object resultCode, msg
```

> ⚠️ **Windows 本机两个坑**（与 macOS 下的 curl 行为不同）：
> 1. `curl.exe` 走 schannel 会报 `curl: (35) ... 0x80092013`，须加 `--ssl-no-revoke`；
>    且 `--data-raw '{"a":1}'` 会被 PowerShell 吞掉双引号，导致
>    `Payload error: Json deserialize error: key must be a string`。**优先用 `Invoke-RestMethod`**。
> 2. 源码路径在 `E:\dolphin\texhub-ai`（非 `/Users/dolphin/Documents/GitHub/texhub-ai`）。

实测结果：`resultCode=200`，`userId=103`（jiangxiaoqiang），
accessToken 有效期至换取时刻 +4h。

## 1.3 Token 使用

JWT（HS256），claims：`userId`、`appId`、`deviceId`、`et`(VIP 到期毫秒)、`exp`。

两种传法（`jwt_auth.rs::get_auth_token`）：

```bash
-H "Authorization: Bearer $TOKEN"      # 推荐
# 或 query 参数（EventSource / pdf.js 无法设 header 时）
'?access_token='"$TOKEN"
```

## 1.4 环境变量约定

```bash
export TEXHUB="https://tex.poemhub.top"
export TEXHUB_PROJ="1ca9d4b0e5734ed1b5d122df09a265f4"
# accessToken 有效期仅 4 小时，别写死；每次现取（见 1.2）：
export TEXHUB_TOKEN="$(curl -s -X POST $TEXHUB/infra/auth/access-token/refresh \
  -H 'Content-Type: application/json' \
  -d "{\"grant_type\":\"refresh_token\",\"refresh_token\":\"$TEXHUB_REFRESH\"}" | jq -r .result.accessToken)"
```

refreshToken 存 `env.md`（已 gitignore），**不要提交**，也不必写进 `.env` 之外的任何文件。

## 1.5 中间件容错（重要）

`AuthMiddleware` 对**无 token / token 非法**不直接拒绝，而是放行并让后续 `LoginUserInfo`
提取器返回 **401**。因此：拿到 401 说明该接口需要登录，与 token 无关。

## 1.6 项目相关查询

```bash
# 我的项目列表
curl -s -H "Authorization: Bearer $TEXHUB_TOKEN" "$TEXHUB/tex/project/list" | jq '.result.projects'

# 项目信息（含主文件 snowflake id，但那是另一个 id 体系，别当 file_id 用）
curl -s -H "Authorization: Bearer $TEXHUB_TOKEN" \
  "$TEXHUB/tex/project/info?project_id=$TEXHUB_PROJ" | jq '.result'

# 主文件
curl -s -H "Authorization: Bearer $TEXHUB_TOKEN" \
  "$TEXHUB/tex/file/main?project_id=$TEXHUB_PROJ" | jq '.result'
```

⚠️ `/tex/project/info` 返回的 `main_file.id`（如 `550039160300240896`）是 **snowflake 整数 id**，
与 `/tex/file/tree` 给的 32 位 hex `file_id` **不是同一个东西**。Yjs 的 `docId` 用后者。
