# 本地优先处理方案（Local-First Processing）

**制定时间**：2026-07-26
**状态**：**P1+P2+P3 全部完成并全绿验收（2026-07-26，见文末第 9/10 节实施记录）**
**一句话**：PDF 处理默认在浏览器完成，文件不再上传；服务器降级为「兜底引擎 + 印章库/账号同步」。

## 1. 背景与动机

当前架构：前端摆章 → 整个 PDF 上传 `/api/process`（pdfcpu 盖章/加密）→ 整个成品下载回来。
生产环境（小带宽服务器）暴露出的问题按重要性排序：

1. **速度受制于服务器带宽**：一份 100MB 合同要完整上传 + 下载，3~5Mbps 的机器上是分钟级。
   本地处理后传输量为零，快慢只取决于用户电脑。
2. **隐私叙事补全**：首页宣传语是「文件不出本机」，本地化让它成为字面事实；
   「阅后即焚」从「服务器不留」升级为「根本不经过服务器」。
3. **服务器成本**：处理挪走后，服务器只剩轻量 API，1 核小机型即可支撑更多用户。

## 2. 目标与非目标

**目标**

- 盖章（placements + 骑缝章）、页面操作（删/转/重排/拼接/图片转 PDF）、扫描效果、
  出件（含加密）在浏览器本地完成；印章库、账号、设置仍走云端同步。
- 任何本地做不了的情况**自动静默回退**到现有服务器管线，用户无感知、功能零回归。
- UI 明示当前路径：出件区显示「✓ 本地处理，文件未上传」或「云端处理（原因）」。

**非目标**

- **移动端优化**（用户明确：基本不在手机上用）。手机上只保证「能用」：本地失败自动走云端，
  不做 Worker 内存精调、不为 iOS 画布上限做特殊分片。
- 不删服务器处理管线。它永远是兜底（奇葩 PDF、低配设备、后续文字章的字体渲染）。
- 不改「印章库在云端」的架构——跨设备同步是账号体系的核心价值，与本方案正交。

## 3. 现状盘点（哪些已经在本地，哪些还在云端）

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| PDF 字节 | ✅ 已在浏览器内存（导入即持有 `PDFFile.blob`） | `web/src/lib/pdfDoc.ts` |
| 页面几何 | ✅ pdfjs 读取，与服务端同一约定（未旋转 pt、原点左下） | `pdfDoc.ts:19` ↔ `internal/pdf/pdf.go:64` |
| 摆章/预览 | ✅ 本地画布 | `features/placements` |
| 骑缝章切片算法 | ✅ 前端已有**逐位一致**实现（mulberry32 + 受限抖动） | `features/seam/slices.ts` ↔ `pdf.go:331-374` |
| 扫描效果 | ✅ 本地（pdfjs 渲染 → canvas → pdf-lib 重建） | `features/scan/processor.ts` |
| 批量 ZIP 打包 | ✅ 本地（jszip） | `features/generate/actions.ts` |
| **盖章执行** | ❌ 云端 pdfcpu | `pdf.go:112 StampPDF` |
| **页面操作执行** | ❌ 云端（compose + 烘录旋转） | `pdf.go:482 ComposePDF`、`rotate.go:28` |
| **图片转 PDF** | ❌ 云端 | `pdf.go:444 ImageToPDF` |
| **输出加密 / 加密输入解锁** | ❌ 云端 pdfcpu AES-256 | `pdf.go:163-173`、`pdf.go:97` |

结论：**只差最后一跳**。pdf-lib 与 pdfjs 都已在懒加载分包里，无新增大依赖（P2 的加密 wasm 除外）。

## 4. 目标架构：本地优先，云端兜底

出件入口（`processFile`）改为路由器：

```
processFile(file)
  ├─ 判定 canRunLocally(file, config)
  │    ├─ 是 → localEngine 处理 ──成功──→ 产物
  │    │                  └──任何异常──→ 落回云端管线（现 /api/process），toast 提示一次
  │    └─ 否（见回退矩阵）→ 云端管线（行为与今天完全一致）
  └─ UI 徽标随实际路径切换
```

**回退矩阵（P1 时点）**

| 情形 | 路径 | 原因 |
| --- | --- | --- |
| 常规盖章/骑缝/直通导出 | 本地 | 主路径 |
| 开扫描效果 | 本地盖章 → 本地扫描 | 扫描本就在本地，串起来即可 |
| 输出加密 | 本地盖章 → **云端补加密**（复用现有「空章+密码」二遍机制，`actions.ts:83-92` 已存在）| pdf-lib 不会加密；P2 用 wasm 收编 |
| 加密输入 + 未开扫描 | 云端 | pdf-lib 打不开加密 PDF；P2 收编 |
| 加密输入 + 开扫描 | 本地 | pdfjs 能带密码渲染，重建产物本身不含加密，绕过了 pdf-lib 的限制 |
| 本地引擎抛任何异常（解析失败/OOM）| 自动重试云端 | 兜底 |
| 文件超过阈值（默认 500MB，可设）| 云端 | 浏览器内存保护；桌面为主所以阈值放宽 |

## 5. 分阶段交付

### P1 —— 本地盖章引擎 + 对齐工装（L：约一周）

**先建验收工装，再移植数学**（顺序不能反，这是本方案最大的风险控制手段）：

1. **对齐验收 harness**（`scripts/verify-local-engine.ps1` + uitest Playwright）：
   同一输入与参数分别过服务器引擎和本地引擎 → pdfjs 以 150dpi 栅格化两份产物 →
   逐像素比对，差异像素占比 < 0.5% 判过。夹具必须覆盖：
   - 旋转 0 / ±37 / 90 / 180（验证旋转**方向**与**轴心**两个语义都对齐）；
   - 不同透明度印章交叠（验证堆叠次序：placements 先、骑缝后，同 `pdf.go:123-152`）；
   - 骑缝章四个边 × 随机种子非 0（验证 `slices.ts` 与像素裁切的逐位一致）；
   - CropBox ≠ MediaBox 的页面、自带 /Rotate 的源页。
2. **`features/generate/localEngine.ts`**（懒加载分包，禁止进入口包，拆包约定见 `boot.ts`）：
   - placements：`embedPng/embedJpg` → `drawImage`。三个语义点必须写测试钉死：
     a) 锚点 = 左下角偏移（服务端 `pos:bl, off:x y`）；
     b) 旋转 = **绕图像中心**、正角为屏幕顺时针。pdf-lib 的 rotate 是绕绘制原点逆时针，
        需要轴心换算；**取负操作全项目只允许出现在引擎边界这一处**（与
        `pdf.go:651 watermarkDesc` 的唯一取负点约定对齐，见审查记录）；
     c) 缩放 = widthPt / 图片像素宽（`pdf.go:256` 同式），透明度走图形状态。
   - 骑缝章：页码解析复用前端 `parsePageExpression`；切片边界复用 `slices.ts`；
     canvas 按边界裁像素 → 逐页 `embedPng`；落点移植 `pdf.go:520 seamPlacement`
     （30 行纯算术）。
   - 直通导出（无章）：源字节原样输出，只改名。
3. **路由与回退**：`processFile` 按第 4 节矩阵分流；本地失败 catch 全部异常回落云端并
   toast「该文件已转云端处理」。
4. **UI 徽标**：出件按钮旁常驻显示当前路径；批量模式逐文件显示。设置里加
   「优先本地处理」开关（默认开）。

**P1 验收**：harness 全绿；一份 50MB 合同在 3Mbps 服务器上出件耗时从分钟级降到秒级；
拔掉网线（仅保留已加载页面）也能完成不加密出件。

### P2 —— 页面操作与加密本地化（M-L：3~5 天）

1. **页面操作**：pdf-lib `copyPages` 实现删/重排/多文件拼接；旋转用 `embedPage` 到
   新尺寸页面上烘录（等价于服务端 `rotate.go` 的「内容流包 CTM + 换 MediaBox」——
   **严禁改用 /Rotate 标记**，全应用坐标不变式依赖烘录，见 `rotate.go:13-24` 注释）；
   图片转 PDF 移植 `pdf.go:444`（A4 等比居中，20 行）。
2. **加密收编**：引入 qpdf-wasm（懒加载，约 1~2MB，仅在用到密码时下载）：
   输出 AES-256 加密本地做，加密输入本地解锁。做完后回退矩阵里只剩
   「引擎异常/超大文件」两种情况需要服务器。
3. 服务器减负：`HLOOL_MAX_PROCESS_BODY_MB` 默认值可下调；DEPLOY.md 更新说明。

### P3 —— 打磨（S-M：1~2 天）

- 本地引擎挪进 Web Worker（现扫描管线在主线程靠 setTimeout 让出，够用但大文件会卡 UI）。
- 阈值与降级策略做成设置项；OOM 捕获后自动降云端重试。
- 文档与宣传语更新（「文件不出本机」恢复为默认事实）。

## 6. 与后续功能的交叉约束

- **文字章/日期章（v2 规划里的 v0.1 项）**：本地做中文文字章需要字体子集化（中文字体
  10MB+ 不可整包下发）。设计时就按「云端 pdfcpu 先行 + 引擎接口预留本地实现」拆分，
  避免先做成云端专属、本地化时返工。
- **盖章模板**：与本方案正交（模板存的是参数，两个引擎共用同一参数模型）。
- 服务器引擎从此是「第二实现」，每次改盖章语义必须同步改两边并跑对齐 harness——
  把 harness 挂进 release 工作流（tag 触发时跑一次）防止静默漂移。

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| pdf-lib 对奇葩/损坏 PDF 容错弱于 pdfcpu | 自动回退云端；harness 夹具持续补录用户报障样本 |
| 旋转轴心/方向移植出错（历史踩坑区） | 工装先行；±37° 非对称夹具专测轴心；取负唯一点约定 |
| 双引擎语义漂移 | 对齐 harness 进 release 流程；两处实现互相注释引用 |
| 浏览器内存峰值（load + save 双份字节） | 500MB 阈值 + OOM 捕获降级；桌面为主可接受 |
| qpdf-wasm 体积 | 懒加载，只有用密码功能的用户才下载 |

## 8. 排期建议

v0.0.5（防丢/打包/缓存等，进行中）→ **v0.1 以 P1+P2 为主打**，「盖章模板」「手写签名」
可并行（不碰引擎），「文字章」排在本方案之后并按第 6 节约束设计。P3 随 v0.1 收尾。

---

## 9. P1 实施记录（2026-07-26 完成）

**交付物**

| 件 | 位置 |
| --- | --- |
| 本地引擎 | `web/src/features/generate/localEngine.ts`（懒加载分包 4.4KB + 共享 pdf-lib 异步包；入口包未增大） |
| 几何换算（纯函数） | `web/src/features/generate/localEngineMath.ts` + `localEngineMath.test.ts`（三语义点 + 烘录矩阵钉死） |
| 服务器参考引擎 CLI | `cmd/refstamp`（直调 StampPDF，绕过 HTTP/鉴权，仅供工装，不进发布构建） |
| 对齐 harness | `scripts/verify-local-engine.ps1` → `scripts/verify-local-engine/`（esbuild + Playwright；夹具由代码确定性生成，仓库不存二进制） |
| 路由与回退 | `processFile`（generate/actions.ts）：`decideRoute` 静态分流 + 本地异常自动落云端（401 除外，直接走重登） |
| UI | 生成按钮旁常驻「本地/云端」徽标（Tip 给原因）；下拉摘要「处理方式」行；「优先本地处理」开关（默认开，localStorage 设备偏好） |

**验收结果**：19 个红线用例全过（150dpi 逐像素，最大差异 0.13% ≪ 0.5% 红线），覆盖
旋转 0/±37/90/180、透明度交叠堆叠序、骑缝四边 × 随机种子 × 跨组随机流 × 页码表达式、
CropBox≠MediaBox（placement 与骑缝都进红线）、自带 /Rotate 的源页（90/180/270 烘录 +
非目标页不烘录）、JPEG 章、直通导出（字节级相等）。数学单测先行（node --test）。

**实现要点（防漂移备忘）**

- pdfcpu 图片水印语义从其源码（v0.12.1 model.Watermark.CalcTransformMatrix）逐式复刻：
  视口 = CropBox；`pos:bl, off` = 未旋转时图片左下角在 vp.LL+(x,y)；旋转绕图片中心；
  尺寸只信 widthPt 与图片纵横比。
- 自带 /Rotate 的源页：pdfcpu 盖章时会把旋转「烘录」进内容流（改 MediaBox/CropBox、
  删 /Rotate、原内容包 `R(−rot)+T` 的 CTM），且**只烘录被盖章的页** —— 本地引擎逐式
  复刻（含这个不对称行为），矩阵见 localEngineMath.bakeRotationSpec。
- 骑缝落位的页面尺寸 = 烘录前 MediaBox + /Rotate±90 交换（serverPageDim ↔ pdfcpu
  PageDims），放置原点 = CropBox.LL —— 与服务端「PageInfo 先于 StampPDF」的时序同构，
  CropBox≠MediaBox 的骑缝因此也逐像素对齐。
- 取负唯一点：服务端 `pdf.go watermarkDesc` ↔ 本地 `localEngineMath.placementDraw`，
  两处注释互引。
- **已知服务端怪癖（本地有意不复刻）**：pdfcpu 在 rot 恰为 ±90.000 时矩形章走「边界
  对齐」特例，与预览（绕中心）偏差 |W−H|/2 —— 这是现存「预览≠产物」bug，方形/圆形章
  无感。本地绕中心 = 所见即所得；harness 以 `quirk-rot90-rect` 信息化用例长期记录
  （实测 2.6% diff）。后续若修服务端此怪癖，把该用例转红线即可。
- P1 回退矩阵的落地口径：加密输入一律云端盖章（扫描保持本地，行为与本地化前完全
  一致）；输出加密 = 本地盖章 → 云端「空章+密码」补加密（P2 qpdf-wasm 收编）；
  >500MB 走云端（常量 LOCAL_MAX_BYTES，P3 做成设置项）。

**遗留到 P2/P3**：页面操作与加密本地化、Web Worker 化、阈值设置项、印章字节的
会话级缓存（当前每次出件按需拉取，几十 KB 级）、harness 挂进 release 工作流。

---

## 10. P2 + P3 实施记录（2026-07-26 完成，同日）

**交付物**

| 件 | 位置 |
| --- | --- |
| 页面操作本地引擎 | `web/src/features/generate/localCompose.ts`：copyPages 删/重排/拼接（连续同文件段一次 copy，与服务端 buildComposeRuns 同构、支持重复页）、旋转烘录（自带 /Rotate + 请求角复合，rotate.go 同式）、图片转 PDF（A4 等比居中） |
| 共享烘录 | `web/src/features/generate/pdfBake.ts`：bakePageRotation（两引擎共用）+ embedWithInterpolate（复刻 pdfcpu「宽或高 <1000px → /Interpolate true」规则） |
| 加密收编 | `web/src/features/generate/qpdf.ts`：@neslinesli93/qpdf-wasm 0.3.0（1.3MB wasm 懒加载，仅用到密码时下载）；AES-256 输出加密 + 加密输入解锁，参数与 pdfcpu NewAESConfiguration(…,256)+PermissionsAll 对齐 |
| Web Worker（P3） | `stampWorker.ts` + `stampJob.ts`：解锁→盖章→加密整链在 Worker 内跑（vite worker.format='es'）；Worker 起不来降级主线程同逻辑，业务错误照旧回退云端 |
| 路由 | `composePdf`/`imageToPdf`（workspace/actions.ts）内部分流+静默回退（所有调用方零改动）；盖章 decideRoute 删掉「加密输入→云端」——回退矩阵只剩「开关关 / 超上限 / 运行期异常」 |
| 设置项（P3） | 「本地处理上限」三档循环 500MB→2GB→不限（生成下拉，localStorage 设备偏好，decideRoute/compose 共用 withinLocalLimit） |
| 服务器减负 | DEPLOY.md：声明本地优先架构；HLOOL_MAX_PROCESS_BODY_MB 说明「兜底接口，可下调至 64」（默认 220 不动，避免存量部署升级后行为突变） |
| 文案（P3） | 登录页宣传语「阅后即焚」→「文件不出本机」 |

**验收结果**：28 个红线用例全绿。新增覆盖：compose 重排/跨文件合并/重复页/三档旋转/
自带 /Rotate 复合旋转（全部 **0.0000%** 差异）、图片转 PDF 横 JPEG + 竖 PNG（0.0000%）、
加密双向往返 —— qpdf 加密件 pdfjs 能直开、pdfcpu 能解密且像素一致；pdfcpu 加密件
qpdf 能解锁、解锁后本地盖章与服务端带密码盖章像素一致。

**过程中收获的关键语义（防漂移备忘）**

- **pdfcpu 图片插值规则**：宽或高 < 1000px 的图片 XObject 一律写 `/Interpolate true`
  （model/image.go，水印与图片导入通用）。未复刻前 image-to-pdf 放大 4.7 倍时边缘
  锯齿差达 3%；复刻后全系归零，连 P1 盖章用例的残余噪声都从 ~0.1% 降到 ~0.005%。
- compose 的旋转 = 「自带 /Rotate + 请求角」的**复合**烘录（rotate.go:85），与盖章
  时只烘自带角不同——pdfBake.bakePageRotation 的 extra 参数区分两种调用。
- qpdf-wasm 的 main() 不保证可重入：每次操作新建 wasm 实例（HTTP 缓存 + 毫秒级
  实例化，可靠性优先）。

**剩余（有意不做/待将来）**：印章字节会话级缓存；
`quirk-rot90-rect` 服务端怪癖修复后转红线；compose 静默回退不 toast（高频小操作）。

**发版轮加固（v0.1.0，2026-07-26）**

- 修 Worker 降级 bug：作业字节从 ArrayBuffer transfer 改为 **Blob 传递**（结构化克隆
  零拷贝、无 detach）——此前 Worker 起不来时主线程降级会拿到已 detach 的空 buffer。
- 堵单页导出漏网点：viewer/pageActions 的 processOnePagePdf 原直连 /api/process，
  改走新抽的 `processDetachedPdf`（本地优先 + 云端回退，语义与 processFile 一致）。
- harness 挂进 release 工作流：`.github/workflows/release.yml` 新增 `verify` job
  （go test + 数学单测 + 28 红线用例），release job `needs: verify`，全绿才发布。
- 新增集成冒烟 `scripts/verify-local-engine/smoke.mjs`：构建 embed 服务器 + Playwright
  真浏览器走完整用户流（登录→传章→摆章→出件→加密→图片导入→关开关回退），断言
  网络行为（本地路径零 /api/* 上传、qpdf.wasm 按需加载、关开关后 /api/process 出现）。
  发版前手动跑（依赖本机 Go + Playwright，不进 CI）。9/9 全绿。

**冒烟抓到的两个真实生产 bug（harness 结构性看不到，因为它在 Node 里直接 import
模块，绕过了 Vite Worker 模块图与 Go embed / CSP 层）——两者都会让整个本地优先
在真实部署上静默失效（文件照旧上传）：**

1. **`//go:embed dist` 静默丢下划线开头的 chunk**：Vite 产出 `_commonjsHelpers-*.js`
   之类共享 chunk，Worker 版 localEngine 依赖它。Go embed 默认跳过 `_`/`.` 开头文件，
   入口页能开但 Worker 内 `import()` 该 chunk 404 → 本地盖章静默回退云端。
   修复：`internal/webui/embed.go` 改 `//go:embed all:dist`。
2. **CSP `script-src` 拦截 WebAssembly**：qpdf-wasm 实例化被 CSP 挡下，本地加密/解锁
   静默回退云端。修复：`internal/server/middleware.go` 的 `script-src` 加
   `'wasm-unsafe-eval'`（仅放开 WASM 的窄指令，≠ `'unsafe-eval'`）。改 index.html
   内联脚本时仍需同步重算那个 sha256 hash。
