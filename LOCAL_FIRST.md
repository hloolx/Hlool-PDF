# 浏览器独立运行架构

本文件记录当前实现；先前“本地优先、自动回退云端”方案归档在 [docs/history/LOCAL_FIRST.md](docs/history/LOCAL_FIRST.md)。

## 运行边界

- 入口直接打开本机 IndexedDB，加载成功才显示工作台；失败可重试，不伪装成空库。
- PDF/密码只保留在标签页内存。所有文件处理使用 pdf-lib、PDF.js、qpdf-wasm、Canvas 与 Web Worker。
- `features/library/storage.ts` 负责 Blob 与偏好事务；预览 URL 由本地 Blob 生成并释放。
- `features/library/settings.ts` 按字段保存并跨标签同步，localStorage 写前日志保护关窗时的未提交设置。
- `features/library/backup.ts` 导出带版本清单的 ZIP，先解码与哈希校验，再事务合并，碰撞图片保留双方。
- `features/generate/browserWorker.ts` 区分启动失败与运行失败。仅启动失败允许主线程重试；运行失败、超时或参数错误直接停止。
- `build/offlinePlugin.ts` 从最终构建产物生成完整 precache，包含 Worker 子构建资源；Service Worker 只缓存显式列出的程序资源。
- `build/pdfAssetsPlugin.ts` 将 PDF.js 的 CMap、标准字体、ICC 和图片解码资源一起静态发布，避免特定文档直到断网时才缺少组件。离线就绪状态由 Worker 核查实际缓存后返回，重试只修补应用资源。
- `state/operations.ts` 为导入、生成、页面处理和备份提供操作令牌，只有持有者可以更新进度和释放忙碌状态。批量生成冻结配置与印章快照，跨标签图片替换使用事务内版本检查。
- 默认构建输出 `web/dist`。没有 API 代理、账号入口或网络处理回退。

## 可保留的功能

普通章、骑缝章、页面拼接/旋转/重排、图片转 PDF、扫描、密码输入/输出、单页导出和批量 ZIP 均在浏览器执行。本地白底透明化取代原在线 AI 抠图入口，复杂背景的 AI 分割不包含在离线版中。

## 保留 Go 的原因

只保留 pdfcpu 的参考算法、几何类型和命令行对比工装。它不属于产品依赖，不参与静态构建、Docker 或默认 CI。其余 Go 服务端代码及 AWS/SQLite 依赖已移除。

下一步若要彻底移除 Go，应先将对比工装固化为覆盖旋转、CropBox、骑缝、透明度和加密等语义的独立 golden 夹具，再删除参考算法；无需为浏览器版重新引入 HTTP 服务。

## 限制与验收

浏览器内存和站点存储仍有限；大小阈值不是可处理能力承诺。扫描与合成在主线程运行；Worker 启动失败时的同步主线程 WASM 无法强制中断。印章备份不含源 PDF 或密码，ZIP 本身未加密。

默认测试：`npm test`。Go 参考测试：`go test ./...`。像素对比：`scripts/verify-local-engine.ps1`。重点断言任何错误分支都不会发出处理 API 或外部上传。
