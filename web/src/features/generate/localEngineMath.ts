/**
 * 本地盖章引擎的几何换算（纯函数，供 localEngine.ts 与对齐 harness 共用）。
 *
 * 复刻服务端 pdfcpu 图片水印语义（internal/pdf/pdf.go watermarkDesc →
 * pdfcpu model.Watermark.CalcTransformMatrix，语义三点）：
 *  a) 锚点 pos:bl —— 未旋转时图片左下角位于「视口(CropBox)左下角 + (xPt, yPt)」；
 *  b) 旋转 —— 绕图片中心，rotation 用前端约定（正角 = 屏幕顺时针）；
 *  c) 尺寸 scale abs —— 宽 = widthPt，高 = widthPt·Hpx/Wpx（服务端只信 widthPt
 *     与图片纵横比，不读 heightPt，见 pdf.go buildPlacementWatermark）。
 *
 * 取负点约定：把「屏幕顺时针正角」翻成「PDF 数学逆时针角」的取负，每个引擎
 * 只允许出现一处 —— 服务端在 pdf.go:651 watermarkDesc，本地引擎在本文件的
 * placementDraw。其余任何层都必须原样传递 rotation（见 2026-07-26 审查记录）。
 *
 * 已知的服务端怪癖（本地故意不复刻）：pdfcpu 在 rot 恰为 ±90.000 时走
 * alignWithPageBoundaries 特例（旋转后包围盒对齐锚点），矩形章会平移
 * |W−H|/2；本地始终绕中心，以「预览即产物」为准。方形章两种语义等价。
 */

export type PlacementGeom = {
  xPt: number
  yPt: number
  widthPt: number
  rotation: number
}

/** 交给 pdf-lib drawImage 的参数（其 rotate 语义：绕绘制原点 (x,y)、正角逆时针）。 */
export type DrawSpec = {
  x: number
  y: number
  width: number
  height: number
  rotateDeg: number
}

export function placementDraw(
  p: PlacementGeom,
  stampWidthPx: number,
  stampHeightPx: number,
  vpX: number,
  vpY: number
): DrawSpec {
  const width = p.widthPt
  const height = (p.widthPt * stampHeightPx) / stampWidthPx
  // 唯一取负点：屏幕顺时针正角 → PDF 逆时针正角（对齐 watermarkDesc 的 rot:-rotation）。
  const rotateDeg = -p.rotation
  const theta = (rotateDeg * Math.PI) / 180
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  // 轴心换算：pdfcpu 绕图片中心转，pdf-lib 绕绘制原点（图片左下角）转。
  // 中心是旋转不动点：先算中心，再倒推旋转后的左下角落点。
  const cx = vpX + p.xPt + width / 2
  const cy = vpY + p.yPt + height / 2
  return {
    x: cx - (width / 2) * cos + (height / 2) * sin,
    y: cy - (width / 2) * sin - (height / 2) * cos,
    width,
    height,
    rotateDeg
  }
}

/** 与服务端 normalizedOpacity 一致：越界（≤0 或 >1）按不透明处理。 */
export function normalizedOpacity(opacity: number): number {
  if (!Number.isFinite(opacity) || opacity <= 0 || opacity > 1) return 1
  return opacity
}

export type PageBox = { x: number; y: number; width: number; height: number }

export type BakeSpec = {
  /** 包住原内容流的 CTM（PDF `a b c d e f cm`，行主序）。 */
  cm: [number, number, number, number, number, number]
  /** 烘录后的页面框（MediaBox 与 CropBox 同置为此框；LL 保持原 CropBox 的 LL）。 */
  box: PageBox
}

/**
 * 自带 /Rotate 源页的烘录变换，逐式复刻 pdfcpu 盖章时的「旋转内在化」
 * （pdfcpu stamp.go addPageWatermark + model.ContentBytesForPageRotation）：
 * 视口(CropBox) ±90 时宽高互换、MediaBox/CropBox 改写为新框、删 /Rotate、
 * 原内容包 R(−rot)+T 的 CTM。非 90 倍数返回 null（调用方回退云端）。
 */
export function bakeRotationSpec(rotateDeg: number, crop: PageBox): BakeSpec | null {
  const rot = ((Math.round(rotateDeg) % 360) + 360) % 360
  if (rot === 0 || rot % 90 !== 0) return null
  const { x, y, width: w, height: h } = crop
  if (rot === 90) {
    return { cm: [0, -1, 1, 0, 0, w], box: { x, y, width: h, height: w } }
  }
  if (rot === 180) {
    return { cm: [-1, 0, 0, -1, w, h], box: { x, y, width: w, height: h } }
  }
  // rot === 270
  return { cm: [0, 1, -1, 0, h, 0], box: { x, y, width: h, height: w } }
}

/**
 * 镜像服务端 PageInfo（pdfcpu PageDims）的页面尺寸语义：MediaBox 宽高，
 * /Rotate 为 ±90/±270 时互换。骑缝章落位公式（seamRectPt）吃的是这套
 * 「烘录前」尺寸 —— 与 server process handler 先 PageInfo 再 StampPDF 的时序一致。
 */
export function serverPageDim(mediaWidth: number, mediaHeight: number, rotateDeg: number): { widthPt: number; heightPt: number } {
  const rot = ((Math.round(rotateDeg) % 360) + 360) % 360
  if (rot % 180 !== 0) return { widthPt: mediaHeight, heightPt: mediaWidth }
  return { widthPt: mediaWidth, heightPt: mediaHeight }
}
