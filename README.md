# hlool pdf

**完全在浏览器运行的 PDF 盖章工作台。** 无需账号、Go 或处理服务器，PDF 和印章都不上传。现有服务端版历史记录保存在 `docs/history/`，当前架构见 [LOCAL_FIRST.md](LOCAL_FIRST.md)。

## 开始使用

在线使用：[pdf.wein.dev](https://pdf.wein.dev)。网站由 Cloudflare Pages 分发，PDF 处理与资料存储仍在你的浏览器内。自行部署见 [DEPLOY.md](DEPLOY.md)。

需要 Node.js 22.13+ 与 npm 10+，在仓库根目录执行：

```powershell
npm --prefix web ci
npm run dev
```

访问 http://127.0.0.1:5173 。这是开发模式，离线缓存未启用。

生产构建与本地预览：

```powershell
npm run build
npm run preview
```

产物只有 `web/dist/` 静态文件，默认预览地址 http://127.0.0.1:4173 。在「本地资料」看到「离线已就绪」后，可断网重新打开相同地址。请保持地址、端口与浏览器一致；不同来源拥有不同资料库。Worker 和 WASM 需要 HTTP(S)，不能双击 `index.html` 以 `file://` 方式运行。

## 功能

- 普通章、骑缝章、位置/尺寸/旋转/透明度调整、撤销重做。
- 跨 PDF 合并、页面重排/删除/旋转、图片转 PDF。
- 多文件独立配置与批量 ZIP 导出。
- 浏览器内 PDF 加解密、AES-256 输出、扫描效果。
- 不同打开密码的 PDF 可分别解锁后合并。
- 印章白底透明化：导入自动处理，支持撤销、手动预览、另存或原位替换。
- 印章与偏好存入 IndexedDB；本地资料菜单提供 ZIP 备份/恢复。
- 生产构建预缓存页面、Worker、PDF 引擎、中文 CMap、标准字体、图片解码与加密 WASM；新版本等待旧标签页关闭后生效，不打断正在处理的文件。缓存缺失时会显示错误，支持重新准备。

## 数据在哪里

| 数据 | 存放位置 | 生命周期 |
| --- | --- | --- |
| PDF 与打开/输出密码 | 当前标签页内存 | 关闭或刷新后需要重新导入 |
| 印章图片、别名、默认尺寸、输出命名 | 当前来源的 IndexedDB | 保留到用户删除或浏览器清除站点数据 |
| 主题、布局、内存保护阈值 | localStorage | 当前浏览器偏好 |
| 文件指纹及章位等恢复配置 | localStorage | 仅参数，最多近期 60 份；不包含 PDF 内容或密码 |
| 应用代码、Worker、WASM | Service Worker Cache Storage | 离线资源；不缓存用户 PDF 或印章 |

**请定期导出资料备份。** 浏览器数据可能因用户清理、隐私模式或存储策略而消失。备份包含印章图片、别名、默认尺寸和输出命名，不包含 PDF、PDF 章位或密码。备份本身未加密，应按印章资料妥善保存。

导入备份会先校验整包，再以一个事务合并：不清空已有印章；同 ID 的不同图片会生成新 ID，保留双方；重复导入同一碰撞备份不会反复复制图片；全局偏好恢复为备份值。无效、损坏或超限备份不会部分写入。单图上限 25 MB；印章库上限为图片合计 200 MB、1000 张，备份另允许 8 MB 清单与 ZIP 开销。

旧在线版的云端印章不会自动下载或迁移。请先从旧版本保存印章图片，再在此版本导入；原服务端资料不会被本次本地代码改动读取或删除。

## 大文件与失败处理

默认本地大小保护为 500 MB，可在生成选项中调整（0 不限）。这是输入大小保护，不是浏览器内存保证；合并、高清扫描和批量 ZIP 的峰值内存可能远大于源文件。超限或引擎失败会停止并提示，**绝不转云端**。

盖章及密码处理优先使用 Worker；Worker 无法启动时可降到主线程。已启动作业超时/崩溃会停止，避免重复执行。扫描与页面合成仍可能占用主线程，大文件建议分批处理。

导入、页面操作、生成和备份互斥执行，避免重复提交。批量生成固定使用开始时的配置、密码及印章图片；异步页面处理检测源文件变化。PDF 尚在工作区或操作未完成时，关闭/刷新会触发浏览器提醒。多标签修改设置按子字段合并，去底弹窗的替换操作会检测图片版本冲突。

## 验证

```powershell
npm run test:unit
npm --prefix web exec -- playwright install chromium
npm run test:browser
```

本机已有 Edge 时可免下载测试浏览器：

```powershell
$env:PLAYWRIGHT_CHANNEL = 'msedge'
npm run test:browser
```

测试覆盖存储事务/配额回滚、备份恢复与碰撞、多标签设置、Worker、密码 PDF、页面操作、桌面/窄屏交互，以及生产版断网刷新后首次使用加密。网络断言拒绝 API、上传及外部请求。

PDF.js 已升级至 6.4.299，Vite 的 esbuild 通过限定 override 使用修复后的 0.28.2+；依赖锁文件随仓库提交。详情及本机验证结果见 [ROADMAP_STATUS.md](ROADMAP_STATUS.md)。

## Go 的去留

Go **不再是产品依赖**。账号、HTTP API、云存储、OAuth、邮件、管理服务和嵌入式前端服务代码已删除。仅保留：

- `internal/pdf/`：旧 pdfcpu 参考引擎及测试。
- `internal/storage/`：参考引擎所需的页面几何类型，无存储实现。
- `cmd/refstamp/` 与 `scripts/verify-local-engine/`：开发时逐像素对比浏览器产物。

前端构建、启动、Docker 与发布流程均不调用 Go。维护参考引擎需要 Go 1.26.4+；`go test ./...` 或 `scripts/verify-local-engine.ps1` 可单独运行。保留它是为了输出回归依据，未来用固定 golden 样本替代后可以整体删除。

静态网站/Docker 用法见 [DEPLOY.md](DEPLOY.md)。许可证：MIT。
