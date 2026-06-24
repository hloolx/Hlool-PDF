# hlool pdf Brand System

> 方向：把 `hlool pdf` 从“红色印章工具”升级成“带有阿懒同学识别度的 PDF 盖章工作台”。功能层保留印泥红，品牌层引入蓝角云茧和南星。

## 1. 品牌定位

**一句话**  
优雅顺手的 PDF 盖章工作台。

**人格**  
懒得折腾，但悄悄把事情处理得很完整。外表是阿懒同学的云茧困脸，内核是直接操作、批量处理、私有安全的专业工具。

**推荐主视觉口号**

- 中文：`拖进来，盖下去，批量收工。`
- 中文短句：`睡着也能批量盖完。`
- 英文：`Stamp PDFs without the paperwork drama.`

**关键词**

- 直接操作：拖章、缩放、旋转、吸附。
- 所见即所得：普通章、骑缝章切片、结果预览。
- 批量闭环：多 PDF 队列、应用到全部、生成全部。
- 私有可信：本地/自托管、认证、加密输出。
- 阿懒识别：白色云茧、黑蓝困脸、钴蓝螺旋角、黄色南星。

## 2. 视觉架构

### 双主色策略

`hlool pdf` 不应变成全蓝的普通工具，也不应继续只是红章图标。建议使用：

- **品牌识别色**：阿懒蓝 `#0B73FF`，用于 logo、链接、插画重点、品牌装饰。
- **产品动作色**：印泥红 `#C8372D`，用于盖章动作、生成按钮、选中态、骑缝色带。
- **可信底色**：深海军蓝 `#071B4A`，用于文字、轮廓、困脸。
- **轻盈空间**：云白 `#F8FBFF` / 纸白 `#FFFFFF`。
- **南星点缀**：`#FFC72C`，只能小面积出现。

### 色彩令牌

```css
:root {
  --brand-navy: #071B4A;
  --brand-blue: #0B73FF;
  --brand-cyan: #9EEBFF;
  --brand-star: #FFC72C;
  --stamp-red: #C8372D;
  --paper-white: #FFFFFF;
  --cloud-bg: #F8FBFF;
  --canvas-soft: #EEF6FF;
}
```

### 造型语言

- 云茧是圆润、可读的整体轮廓，不画真实羊毛。
- 困脸必须黑蓝、高对比、半眯眼，不要笑脸和大眼萌。
- 螺旋角放在右上，尺寸要大，尤其 favicon。
- 南星只做小点缀，不变成星星主题。
- 红章元素是功能符号，不进入阿懒身体主体，避免破坏 IP 识别。

## 3. Logo 系统

### 方案 A：阿懒工作章主标（推荐）

文件：`svg/logo-mark.svg`  
用途：GitHub avatar、README 顶部、App about、发布页、社交头像。

优势：

- 阿懒四个锚点完整。
- 带一个红章动作符号，产品域明确。
- 大图展示很稳，适合品牌主形象。

风险：

- 细节较多，不建议直接做 16px favicon。

### 方案 B：极简蓝角云茧 icon（推荐用于小尺寸）

文件：`svg/app-icon.svg`、`svg/favicon-alan.svg`  
用途：Windows exe icon、browser favicon、dock/app tile、小徽章。

优势：

- 蓝角和困脸在小尺寸仍可读。
- 红色只做角落功能提示，不生成伪文字。

风险：

- 比方案 A 更产品化，情绪表达更少。

### 方案 C：横向 lockup

文件：`svg/logo-lockup-horizontal.svg`  
用途：README 顶部、官网/文档页 header、发布物料。

优势：

- 解决 image model 不适合生成文字的问题。
- 中英文描述可以精确控制。

建议：

- 产品内顶栏仍保持轻量，不要把完整 lockup 塞进 52px 顶栏。
- 文档和官网使用完整 lockup，应用内使用 app icon + `hlool pdf` 文本。

### 方案 D：现有红色“印”图标（保留为 legacy）

文件：`web/public/favicon.svg`  
用途：可以保留在旧版本、纯工具态、无 IP 场景。

不建议继续做主品牌，因为它太像通用盖章工具，缺少 `hlool/有南/阿懒同学` 识别。

## 4. 生成图片候选集

目录：`generated/`

| 文件 | 用途 | 建议 |
|---|---|---|
| `01-main-mascot-logo-candidate.png` | 主头像、品牌大图 | 强推荐。阿懒识别完整，红章不抢戏。 |
| `02-minimal-icon-exploration-reject-pseudotext.png` | 探索稿 | 不推荐。左上角红符号像伪文字，留作反例。 |
| `03-minimal-app-icon-candidate.png` | app icon 探索 | 推荐参考，但正式小图标用 `svg/app-icon.svg` 更稳。 |
| `04-readme-hero-product-workspace.png` | README hero / 发布图 | 强推荐。最像“大厂产品图”。 |
| `05-readme-workflow-explainer.png` | README 流程解释 | 推荐。导入、拖章、骑缝、生成四步清楚。 |
| `06-empty-import-state.png` | 空状态插画 | 推荐。可以替换导入空态或文档页插画。 |
| `07-batch-queue-feature.png` | 批量盖章功能图 | 推荐。适合“生成全部”段落。 |
| `08-security-private-workspace.png` | 安全/私有部署图 | 谨慎使用。质感好，但偏暗、偏 3D。 |
| `09-page-organizer-feature.png` | 页面整理/拼接图 | 推荐。适合页面整理功能段落。 |

总览图：`mockups/generated-contact-sheet.jpg`

## 5. README 视觉结构

推荐 README 首屏：

1. 顶部使用 `svg/readme-banner.svg` 或 `generated/04-readme-hero-product-workspace.png`。
2. 标题下用三枚短 badge：`direct stamp`、`batch`、`private`。
3. 第一屏只讲价值，不塞 API。
4. 功能段落配 `generated/05/07/09` 三张图。
5. API、部署、开发命令放在后半段，减少首屏工具书感。

推荐图片顺序：

- Hero：`generated/04-readme-hero-product-workspace.png`
- Workflow：`generated/05-readme-workflow-explainer.png`
- Batch：`generated/07-batch-queue-feature.png`
- Organizer：`generated/09-page-organizer-feature.png`
- Security：`generated/08-security-private-workspace.png` 或后续重生一个更扁平版

## 6. 图标系统

文件：`svg/feature-icons.svg`

六个功能图标：

- `direct stamp`：拖章盖印
- `seam slice`：骑缝切片
- `batch queue`：多文件队列
- `page organize`：页面整理
- `private file`：私有/加密
- `day night`：昼夜主题

建议后续如果接入代码，拆成单独 SVG component，保持同一线宽：5px、圆角端点、深蓝轮廓、红色只表达盖章动作。

## 7. README 图片解释文案

可直接放在 README 图下：

- 主图：`一个直接操作的 PDF 盖章工作台：拖入文件，把印章放到页面上，骑缝章切片实时预览，完成后立即生成结果。`
- 流程图：`从导入到生成只保留四个动作：导入文件、拖章定位、确认骑缝切片、输出最终 PDF。`
- 批量图：`多 PDF 队列会保存每个文件的配置，也可以把当前配置一键应用到全部文件。`
- 页面整理图：`页面整理支持跨 PDF 混排、拖拽排序、删页和拼接输出。`
- 安全图：`本地桌面或自托管运行，支持认证边界与 AES-256 输出加密。`

## 8. 使用边界

必须做：

- 小尺寸图标使用 SVG 正稿，不直接裁 AI 图。
- README hero 可以用 AI 生成图，因为它是情绪和解释图。
- 每个视觉资产保留阿懒三锚点以上：云茧、困脸、蓝角、南星。

不要做：

- 不要在 AI 图里放 `hlool pdf` 文本。
- 不要把红章变成大面积背景纹理。
- 不要让阿懒微笑、卖萌、变成普通小羊。
- 不要把 UI 做成纯蓝或纯红单色系统。

## 9. 下一轮迭代建议

优先级最高：

1. 基于 `svg/favicon-alan.svg` 做 16/32/48/256 多尺寸 `.ico`。
2. 用 `generated/04` 和 `svg/readme-banner.svg` 二选一重排 README。
3. 重新生成一张更扁平、更亮的安全图，替代 `08`。
4. 将 `feature-icons.svg` 拆成单文件，用到 README 功能卡。
5. 如果要改产品内 UI，把顶栏红色“印”替换成 `favicon-alan.svg` 风格的小标。
