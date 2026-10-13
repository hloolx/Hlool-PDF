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
