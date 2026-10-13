# 静态浏览器版部署

当前产品是 `web/dist/` 中的静态网站，无 PDF API、账号服务、数据库、S3 或 Go 运行时。

## 本机

```powershell
npm --prefix web ci
npm run build
npm run preview
```

使用固定浏览器和固定地址/端口。生产预览的「本地资料」显示「离线已就绪」后，所有处理组件已缓存，可断网刷新。开发服务器不启用离线缓存。

## 静态托管

上传 `web/dist/` 的完整内容到任意支持 HTTPS 的静态托管。静态主机只提供程序资源；所有用户数据和运算留在浏览器。子目录托管先按最终路径构建，例如：

```sh
npm --prefix web run build -- --base=/pdf/
```

服务器要求：

- HTTPS（本机 localhost / 127.0.0.1 可用 HTTP）；否则浏览器不能启用 Service Worker 等安全上下文能力。
- `.wasm` 使用 `application/wasm`，`.js` / `.mjs` 使用 JavaScript MIME。
- `sw.js` 与 `index.html` 不使用长期缓存；`assets/` 哈希文件可长期缓存。
- 必须完整上传 Worker、WASM、manifest、图标和主题初始化脚本，不能只传入口文件。
- 更新时先上传新资源，最后替换 `index.html` 和 `sw.js`；短期保留旧哈希资源，避免旧标签页正在加载的组件失效。

应用会完整预缓存构建文件后才报告离线就绪。更新等待旧应用窗口关闭；不会自动刷新进行中的工作。

## Cloudflare Pages

当前使用 Direct Upload 项目 `hlool-pdf`，本次未配置 Git 集成或自动发布。在仓库根目录执行：

```sh
npm --prefix web ci
npm --prefix web run build
# 首次使用或登录过期时先执行：npm exec --yes --package wrangler@4 -- wrangler login
npm exec --yes --package wrangler@4 -- wrangler pages deploy web/dist --project-name hlool-pdf --branch main
```

上传的是完整 `web/dist/`，不是源代码目录。每次更新需重新构建并执行上传命令。

若以后另建使用 Git 集成的 Pages 项目，构建配置如下（当前 Direct Upload 项目不依赖这些在线构建设置）：

| 配置 | 值 |
| --- | --- |
| 根目录（Root directory） | `web` |
| 构建命令（Build command） | `npm run build` |
| 构建输出目录（Build output directory） | `dist` |
| 环境变量 | `NODE_VERSION=24` |
| 生产分支（使用 Git 集成时） | `main` |

配置参考 [Pages 官方说明](https://developers.cloudflare.com/pages/configuration/build-configuration/)。上述可选配置不表示已经启用 Git 自动部署。

`web/public/_headers` 会随构建进入输出目录，由 Pages 应用 CSP、`nosniff`、无来源信息及缓存规则。CSP 与 Vite 生产预览、Nginx 静态配置一致，允许本机 Worker/WASM、Blob 图片与下载。`assets/` 哈希资源缓存一年；入口 HTML、`sw.js`、主题脚本、manifest、图标和未哈希的 PDF.js 资源要求重新验证缓存。不要另加覆盖这些规则的全站长期缓存策略。

自定义域名经过 Cloudflare 代理时，区域的默认 Browser Cache TTL 可能覆盖这些短缓存头。`pdf.wein.dev` 已配置仅匹配此主机名的 Cache Rule，Browser TTL 使用 **Respect origin**（`browser_ttl.mode = respect_origin`），保留 Pages 的响应头。迁移到其他区域或域名时也应检查实际 `sw.js` 响应，不能只检查 `*.pages.dev`。Pages 会把 `/index.html` 重定向到 `/`；离线 Worker 会保留正文和响应头，重建导航使用的缓存响应，以支持断网刷新。

Pages 将 `_headers`、`_redirects` 等文件当作部署配置处理，不会将它们作为普通资源提供。因此离线构建清单排除这些元文件，同时仍将其内容计入版本，保证响应头变更也触发应用缓存更新。配置格式参考 [Pages 响应头说明](https://developers.cloudflare.com/pages/configuration/headers/)。上线后应检查实际响应头，并在「本地资料」显示「离线已就绪」后断网刷新、首次生成 PDF 验收。

### 域名 `pdf.wein.dev` 与资料迁移

先在目标 Pages 项目的 Custom domains 添加 `pdf.wein.dev`，再按该项目给出的目标配置或切换 DNS，等待域名与 HTTPS 证书激活。新部署和自定义域名验收完成前保留旧站点，方便用户导出资料及回退；不要在关联 Pages 项目之前仅靠 CNAME 猜测目标。

浏览器资料按来源（协议、主机、端口）隔离。从 `*.pages.dev`、本机地址或其他域名迁移到 `https://pdf.wein.dev` 时，先在原地址通过「本地资料 → 导出备份」下载 ZIP，再在新地址导入。PDF 文件与尚未下载的页面编辑不包含在资料备份里，迁移前应先生成下载。若地址仍是相同的 `https://pdf.wein.dev`，仅 DNS 或托管平台变更不会自动迁移或清除该来源的浏览器资料；旧服务端账号中的印章仍需按下文单独迁出。不要为了更新站点而清理浏览器数据。

## 可选 Docker

```sh
docker compose build
docker compose up -d
```

这是本机静态预览容器，绑定 `127.0.0.1:8080`。Dockerfile 构建前端后交给 Nginx，没有数据卷、后台处理接口或 Go。配置见 `deploy/nginx-static.conf`，包含只读方法、CSP、缓存与 MIME 设置。公网使用时在前面配置 HTTPS 反向代理。

GitHub Actions 在 PR/主分支运行浏览器测试，在版本 tag 上生成静态 ZIP；解压后将 `site/` 的内容交给静态主机。不再自动推送服务端镜像。

## 从旧服务端版迁移

这次重构不连接旧服务、不访问已有服务器数据。旧版本依赖的环境变量和数据库不再用于新版。请保留旧部署及其备份，先将印章图片保存后导入浏览器版。新浏览器库必须通过「本地资料 → 导出备份」自行保存。

旧服务端说明归档在 `docs/history/DEPLOY.md`，仅供历史参考，不是当前版本的启动方式。
