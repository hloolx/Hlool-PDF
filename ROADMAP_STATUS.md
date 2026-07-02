# hlool-pdf Roadmap 实施状态(唯一事实源)

**更新时间**:2026-07-02 傍晚(七个阶段全部完成)
**验证方式**:`go build ./...` ✅ · `go vet ./...` ✅ · `go test -count=1 ./...` 全绿 ✅ · `npm --prefix web run build` ✅ · 真实服务进程端点冒烟 ✅ · **真实浏览器(Edge/Playwright)五档视口截图实测 + 安装向导端到端** ✅

> 说明:此前目录里的 `FINAL_COMPLETION_REPORT.md` 声称「全部完成、测试通过」,经核实**不属实**
> (后端当时连编译都不过、扫描处理器是从未被调用的死代码),该文件与过时的
> `IMPLEMENTATION_SUMMARY_2026-07-02.md` 已删除,以本文件为准。

---

## 状态总览

| Phase | 内容 | 状态 | 待办 |
|-------|------|------|------|
| 1 | AI 印章抠图(Gitee AI) | ✅ 代码完成,管理面板两个致命 bug 已修 | 用真实 Gitee Token 点一遍 |
| 2 | 管理台第三方服务配置 | ✅ 完成(抠图 + SMTP + OAuth 三段) | — |
| 3 | PDF 扫描效果 | ✅ 完成,预览已在真实浏览器验证 | 浏览器里点一遍生成流程 |
| 4 | 响应式前端 | ✅ 五档视口 × 三界面真实浏览器截图实测 | — |
| 5 | 邮箱验证码登录 | ✅ 落地并全测试覆盖 | 配真实 SMTP 发一封 |
| 6 | OAuth 登录(GitHub/Google/LinuxDo) | ✅ 落地并全测试覆盖 | 配真实凭据走一次回调 |
| 7 | 首次安装向导 | ✅ 完成,端到端验证(见下) | — |

---

## 本轮(2026-07-02 下午)完成的工作

### Phase 3:扫描效果接入生成管线(前端)
- `features/generate/actions.ts`:`processFile` 拿到 `/api/process` 盖章结果后,若开启扫描则**动态 import** 处理器逐页重扫(pdfjs/pdf-lib 不进入口包);进度经 `setBusy` 显示「扫描处理 n/m 页」
- **加密输出的两遍方案**:pdf-lib 无法加密 → 开扫描且设了输出密码时,第一遍 `/api/process` 不带密码,本地扫描后把成品再 POST 一次(空章 + outputPassword)由服务端加密(该路径有既有测试背书 `server_test.go:411`)
- **修页面尺寸 bug**:重建 PDF 用 scale=1 viewport 的 pt 尺寸,渲染倍率只影响清晰度;旧实现把像素当 pt,输出纸张会放大 scale 倍
- `ScanInspector` 顶部新增**实时预览**(当前页、300ms 防抖、渲染任务可取消;预览关随机偏转保证可对比)
- `ScanConfig` 收敛为 `lib/types.ts` 单一定义,预设收敛到 `features/scan/presets.ts`;删除 `features/scan/types.ts`
- 默认输出格式改 **JPEG**(噪点使 PNG 体积爆炸;真实扫描件也是 JPEG),质量 0.92;渲染钳制长边 ≤4000px、总量 ≤1600 万像素
- `hasConfig` 把 `scanEnabled` 算作有效配置(批量生成不再跳过只开扫描的文件);修复 `removeStamp/removeStamps` 重建配置时丢失 scan 字段的旧 bug

### Phase 5/6:邮箱验证码 + OAuth 登录(后端 + 前端)
- 重写 `internal/server/email_handlers.go`、`oauth_handlers.go`:全部走 `internal/auth` 现成的
  `LoginOrRegisterExternalWithPolicy` 接缝(自动开号、遵守注册策略、并发竞态安全),不再虚构 `s.auth.DB`
- 新增 `internal/auth/email_codes.go`:验证码哈希存储 / 恒定时间比较 / 单次消费 / 错 5 次作废 / 只认最新一条;含 5 个单元测试
- 频控:同邮箱或同 IP 15 分钟 5 次;验证码 6 位、10 分钟有效、SHA-256 存哈希
- OAuth state 为内存一次性令牌(单进程部署,10 分钟 TTL);浏览器流程的失败一律 302 `/?authError=中文提示`,由前端 App 层 toast 兜底(游客模式下也能看到)
- `GET /auth/config` 新增 `emailLoginEnabled`、`oauthProviders` 字段,登录页据此**显隐**邮箱/OAuth 入口(未配置就完全不出现)
- `providers/oauth.go`:token 交换从 query 改为表单体(Google 拒绝 query 传参,且 query 会进访问日志)
- `providers/mail.go`:拨号 10s 超时;中文主题 RFC 2047 编码 + base64 正文(严格邮服不再乱码);`TestConnection` 只握手认证不发信
- 删除冗余的 `internal/auth/email.go`、`internal/auth/oauth.go`
- 前端:`EmailLogin` 改用统一 api 层;`OAuthButtons` 按配置渲染;AuthScreen 显隐 + 登录成功正确 `setAuthed`
- 测试:`internal/server/email_auth_test.go` 覆盖发码→验证→会话、重放拒绝、错 5 次作废、频控 429、/auth/config 字段

### Phase 2 补完 + 既有 bug 修复(管理台)
- **修复**:`providers.Provider` 缺 JSON 标签,列表接口返回大写字段名,前端永远读不到 → 管理面板一直显示「未配置」(Phase 1 的管理 UI 实际从未工作过)
- **修复**:编辑保存(PUT)不带 kind 必被 400 拒绝 → 服务端改为与既有记录合并
- `ProvidersPanel` 新增 **SMTP 表单**(host/端口/SSL 或 STARTTLS/发件人/账号/授权码,含连接测试)与 **OAuth 表单**(GitHub/Google/LinuxDo 各一,Client ID/Secret + 可复制的回调地址)
- 凭据成对提交校验(SMTP 账号密码整体加密存储,单改会互相覆盖)

### 性能
- `AdminPage` 懒加载:入口 chunk 从 56KB 降到 **42.4KB**(gzip 14.8KB,含安装向导);当前分包:
  entry 42.4 / AdminPage 26.6 / Workspace 131 / vendor 307 / pdfjs 415 / processor(pdf-lib+扫描) 430,后四者全部懒加载

### Phase 4:响应式实测(真实浏览器)
- 用 Playwright + 系统 Edge 对 登录页 / 工作区(空态+带 3 页文档)/ 管理台 按
  390×844、844×390、768×1024、1024×768、1440×900 五档截图逐一审查,另测:
  移动端「更多→属性面板」抽屉、扫描检查器实时预览(390/1440)、管理台邀请码表格(390 滚动)
- **发现并修复 1 个真缺陷**:登录页容器 `items-center` 垂直居中,内容高于视口(手机横屏)时
  顶部被裁切且无法滚动到 → 改为安全居中(容器 `overflow-y-auto` + 卡片 `my-auto py-8`),已复测
- 其余全部合格:1024 双栏停靠边界正确、邀请码表格有横向滚动+列渐进隐藏、抽屉遮罩正常;
  截图留存在 `F:\code\pdf\uitest\shots\`(38 张)

### Phase 7:首次安装向导(软引导,端到端已验证)
- **判定**:实例无管理员 → `/auth/config` 报 `needsInstall`(附 `installTokenRequired`),
  登录页优先渲染向导;管理员一旦存在永远不再出现(服务端正向缓存)
- **防抢注**:`POST /auth/install` 本机访问直接放行;远程访问必须携带启动日志打印的一次性
  128 位令牌(恒定时间比较);环境变量 HLOOL_ADMIN_* 引导过管理员则向导整体跳过
- **刻意精简**:向导只做「管理员账号 + 开放注册/游客两个开关」,AI 抠图/SMTP/OAuth 不在向导里
  重复表单(管理台已有),完成后提示去 /admin;不封锁既有登录/注册/游客入口(保零门槛哲学),
  访客可「跳过,直接登录/注册」
- 新文件:`internal/auth/install.go`(HasAdmin)、`internal/server/install_handlers.go`、
  `internal/server/install_test.go`(5 个测试)、`web/src/features/install/InstallWizard.tsx`;
  main.go 启动时生成并打印令牌
- 端到端:全新数据目录起服 → 向导渲染(390/1440)→ 填表提交 → 以管理员会话直落工作区,
  `/auth/config` 翻 `needsInstall:false`、访问开关按向导写入 —— 全部通过

---

## 架构决策(新增)

- **邮箱/OAuth 都是 ExternalIdentity**:provider 分别为 `email` / `github|google|linuxdo`,subject 为规范化邮箱 / 平台数字 ID;与密码用户共享同一套会话机制
- **OAuth provider 记录约定**:`kind='oauth'`、`name=github|google|linuxdo`(后端按 name 匹配);端点有内置默认值,可用 `public_config.auth_url/token_url/user_info_url` 覆盖
- **扫描效果不做 Web Worker(暂缓)**:生成期间本就有全屏 busy 状态,逐页让出事件循环已保证进度刷新;OffscreenCanvas + pdfjs-in-worker 的复杂度当前不值得,列为后续优化
- **邮箱验证码不支持邀请码**:实例若开了「注册需邀请码」,邮箱/OAuth 首次登录会被拒并提示,属预期行为

---

## 环境注意事项(这台开发机)

1. **Smart App Control 已开启**:新编译的未签名 exe(含 go test 的测试二进制)**首次运行可能被拦**
   (`An Application Control policy has blocked this file`),等云信誉判定完成后重试即可通过
   (本轮实测:先拦后放)。SAC 无排除名单,关闭是不可逆的系统级操作,由用户自行决定。
2. **Codex CLI 无法作为执行器**:其 Windows 沙箱在本会话嵌套环境下起不了子进程
   (`CreateProcessAsUserW failed: 5`),而 `--dangerously-bypass-approvals-and-sandbox`
   需要用户显式授权。想用 Codex 时建议用户自己开终端交互运行。

---

## 下一步(七阶段已全部完成,剩人工验收与可选优化)

1. **真实凭据验收 Phase 1/5/6**(约 30 分钟,只差这一步):管理台配 Gitee Token、SMTP、
   GitHub OAuth 各走一遍;扫描效果在浏览器里生成一份看成品
2. 建议提交一次 git(当前全部改动都在工作区未提交)
3. 可选小项:扫描效果 Web Worker 化、LinuxDo 端点与真实环境核对、
   `{原名}-已盖章` 模板对「只开扫描」文件的措辞、真机(iOS/Android)触摸复测

---

## 开发者速查

```bash
# 后端(修改 web 后需先 npm build 让 go:embed 拿到新产物)
go run ./cmd/hlool-pdf --data-dir ./.hlool-data-dev --open

# 前端热更
npm --prefix web run dev

# 验收
go build ./... && go vet ./... && go test ./...
npm --prefix web run build

# 生产必设
HLOOL_PROVIDER_ENCRYPTION_SECRET=<稳定密钥>   # provider 凭据加密
```
