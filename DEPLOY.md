# 部署与安全配置（hlool-pdf 多用户在线版）

服务端把 PDF 处理做成**阅后即焚**：上传 → 临时目录处理 → 同一响应流回成品 → 立即删除
（外加一个兜底定时清扫）。服务器任何时刻都不长期保存 PDF。用户库（印章 + 设置）按
登录用户 uid 隔离，存储后端可插拔：配了 S3 用 S3，否则用服务器本地磁盘。认证始终开启。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HLOOL_ADDR` | `127.0.0.1:8088` | HTTP 监听地址（可用 `-addr` 覆盖） |
| `HLOOL_DATA_DIR` | 用户配置目录/hlool-pdf | SQLite 用户库 + 本地存储后端的数据目录（可用 `-data-dir` 覆盖） |
| `HLOOL_ALLOWED_HOSTS` | 空 | Host 头白名单（逗号分隔，防 DNS rebinding）。空=放行任意 Host，适合直接 IP、宝塔和临时部署；有固定域名后可再收紧 |
| `HLOOL_CORS_ORIGINS` | 空 | 允许的跨域来源（逗号分隔；一般同源部署留空即可） |
| `HLOOL_BEHIND_PROXY` | `false` | 信任上游反代的 `X-Forwarded-Proto`/`X-Forwarded-For`（TLS 由反代终结时设为 1） |
| `HLOOL_TLS_CERT` / `HLOOL_TLS_KEY` | 空 | 同时设置则启用内置 HTTPS 监听 |
| `HLOOL_SECURE_COOKIES` | 自动 | 会话 Cookie 的 Secure 标记。默认在 TLS 或反代下为 true；本地 http 调试自动为 false。可显式覆盖 |
| `HLOOL_ADMIN_USERNAME` / `HLOOL_ADMIN_PASSWORD` | 空 | 启动时创建或刷新管理员账号（两者必须同时设置）。管理员登录后可访问 `/admin` |
| `HLOOL_ALLOW_REGISTER` | `true` | 注册总开关的启动默认值；后台保存后以 SQLite 中的设置为准 |
| `HLOOL_REQUIRE_INVITE` | `false` | 是否要求邀请码注册的启动默认值；后台保存后以 SQLite 中的设置为准 |
| `HLOOL_ALLOW_THIRD_PARTY_REGISTER` | `true` | 第三方身份首次自动开号的启动默认值；已有外部身份登录不受影响 |
| `HLOOL_ALLOW_GUEST` | `true` | 是否允许临时游客身份；后台保存后以 SQLite 中的设置为准 |
| `HLOOL_MAX_PROCESS_BODY_MB` | `220` | `/api/process`、`/api/compose` 的请求体上限 |
| `HLOOL_MAX_STAMP_MB` | `20` | 单个印章图片上限 |
| `HLOOL_MAX_CONCURRENT_JOBS` | CPU 核数 | 同时处理的重型 PDF 任务上限（盖章/拼接/图片转 PDF）；超出的请求短暂排队，仍无空位则返回 503。**小内存机器请调低**（每个任务可能瞬时占用源文件数倍内存） |

### S3 后端（设了 `HLOOL_S3_BUCKET` 即启用，兼容 AWS S3 / Cloudflare R2 / MinIO / Backblaze B2）

| 变量 | 说明 |
| --- | --- |
| `HLOOL_S3_BUCKET` | 桶名。设置后切到 S3 后端 |
| `HLOOL_S3_REGION` | 区域（AWS 必填；自定义 endpoint 时可省，留空自动取 `auto`，适配 R2） |
| `HLOOL_S3_ENDPOINT` | 自定义 endpoint（指向 R2 / MinIO 等 S3 兼容存储） |
| `HLOOL_S3_PREFIX` | 可选 key 前缀，置于 `users/{uid}/…` 之前 |
| `HLOOL_S3_FORCE_PATH_STYLE` | MinIO 一般需设为 1；R2 用虚拟主机风格可留默认 0 |
| `HLOOL_S3_SSE` | 服务端加密：`none` / `AES256`（SSE-S3）/ `aws:kms`。**默认**：AWS（无自定义 endpoint）为 `AES256`，自定义 endpoint 为 `none` |
| `HLOOL_S3_KMS_KEY_ID` | `HLOOL_S3_SSE=aws:kms` 时使用的 KMS key（留空走账号默认 `aws/s3` 键） |
| `HLOOL_S3_CHECKSUM` | `required`（默认）/ `supported`。默认关闭 SDK 的 CRC + aws-chunked 上传，兼容 R2/B2/部分 MinIO；仅在原生 AWS 上可设 `supported` 获取额外完整性校验 |

凭证走标准 AWS 链（`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / IAM 角色等），**绝不**由本程序的
环境变量直接传入。印章内容只经后端代理下发，**不使用预签名 URL**。

**为什么默认关 checksum 与 SSE 头**：较新的 aws-sdk-go-v2 默认给每次上传附加 CRC 校验和并改用
`aws-chunked` 传输编码，而 R2、B2、部分 MinIO 会拒绝该编码导致上传失败；同理 R2/B2 自身已在落盘时
加密、再发 `x-amz-server-side-encryption` 头可能报错。因此本服务对**自定义 endpoint 默认走最兼容路径**，
原生 AWS 仍默认 `AES256`，两边都能开箱即用，需要时再用上表显式覆盖。

**各家最小配置示例**

- **AWS S3**：`HLOOL_S3_BUCKET` + `HLOOL_S3_REGION`（SSE 自动 `AES256`）。
- **Cloudflare R2**：`HLOOL_S3_BUCKET` + `HLOOL_S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com`
  （region 自动 `auto`、SSE 自动 `none`、checksum 自动 `required`，无需额外设置）。
- **MinIO**：`HLOOL_S3_BUCKET` + `HLOOL_S3_ENDPOINT` + `HLOOL_S3_FORCE_PATH_STYLE=1`。
- **Backblaze B2（S3 兼容端点）**：`HLOOL_S3_BUCKET` + `HLOOL_S3_ENDPOINT` + `HLOOL_S3_REGION`。

不配 S3 = 纯本地、零云依赖（自托管）。

## 安全加固清单（已内置）

- **认证**：Argon2id 口令哈希；登录下发 `HttpOnly + Secure + SameSite=Strict` 会话 Cookie；
  会话存服务端 SQLite、可吊销；登录失败按「IP+用户名」限流锁定；注册按 IP 限流。Token 绝不进 localStorage。
- **越权防护**：用户库的 key/路径一律由服务端按会话 uid 拼接，客户端无法指定 uid 或完整路径；
  uid/印章 id 受严格字符校验，杜绝路径穿越。
- **HTTP 头**：CSP（`default-src 'self'; connect-src 'self'; frame-ancestors 'none'` 等）、
  `X-Content-Type-Options`、`X-Frame-Options: DENY`、`Referrer-Policy`，TLS/反代下加 HSTS。
- **Host 白名单**：`HLOOL_ALLOWED_HOSTS` 堵 DNS rebinding。
- **错误脱敏**：内部错误只记服务端日志，响应统一返回通用文案，不回传路径/存储 key。

## 扩展：第三方登录（已留好接缝）

后端已为「插入新的登录方式」铺好可复用接缝，无需改动现有用户库/会话逻辑：

- **数据层**：`identities` 表以 `(provider, subject)` 唯一键映射到本地账号，随账号级联删除
  （与会话一致）。一个账号可绑定多个外部身份。
- **服务层**：`auth.Service.LoginOrRegisterExternal(ctx, ExternalIdentity{Provider, Subject, DisplayName, Email})`
  是唯一入口——首次见到的身份会自动开号（用 `DisplayName` 派生并去重用户名、写入不可用口令哈希，
  从此走与口令账号完全一致的会话机制：Cookie、过期、吊销、清扫），老身份直接发新会话。
- **接入一个 Provider 只需写一个 handler**：用该家 SDK 校验回调 token → 拼出 `ExternalIdentity`
  → 调 `LoginOrRegisterExternal` → `SetSessionCookie`，与现有口令登录 handler 同形。前端 `/auth/me`
  契约不变，拿到的仍是同一个用户视图，无需特判。
- 当前未内置任何具体 Provider（Google/GitHub/SAML…），避免在缺少密钥配置时塞入死代码；
  需要时按上面四步插入，会话与越权防护自动复用。

## 宝塔 / 面板二进制部署

从 v0.0.3 起，Release 里的平台压缩包会在根目录带上两个文件：

- `hlool-pdf.env`：默认运行配置，程序启动时会自动读取。
- `hlool-pdf.env.example`：同内容的示例备份。

默认配置适合宝塔这类面板直接运行：

```env
HLOOL_ADDR=0.0.0.0:8080
HLOOL_DATA_DIR=./data
HLOOL_ALLOWED_HOSTS=
HLOOL_BEHIND_PROXY=0
HLOOL_ALLOW_GUEST=0
```

也就是说，解压后在宝塔里把启动文件指向 `hlool-pdf`，再放行服务器安全组/防火墙的
`8080` 端口，就可以访问：

```text
http://服务器IP:8080
```

如果要改端口，直接改同目录下的 `hlool-pdf.env`：

```env
HLOOL_ADDR=0.0.0.0:你的端口
```

首次访问会进入安装向导；远程初始化令牌会打印在程序日志里。

## S3 桶硬化（必做）

1. **Block Public Access**：桶级四项全开（禁止任何公开访问）。
2. **仅 TLS**：桶策略拒绝非加密传输。示例：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::YOUR_BUCKET",
        "arn:aws:s3:::YOUR_BUCKET/*"
      ],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
```

3. 建议再开启**默认加密 SSE-S3**（程序写入时也已逐对象指定 SSE-S3，双保险）。
