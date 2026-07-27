/**
 * 页面旋转烘录（pdf-lib 版），本地盖章引擎与本地页面操作引擎共用。
 * 逐式对齐服务端两处实现：
 *  - internal/pdf/rotate.go bakePageRotation（用户请求的旋转：total = 自带 /Rotate + 请求角）
 *  - pdfcpu 盖章时的旋转内在化（仅自带 /Rotate：extra = 0）
 * 严禁改用 /Rotate 标记 —— 全应用「几何 = 有效 pt、原点左下」不变式依赖烘录
 * （见 rotate.go:13-24 注释）。
 */
import { PDFArray, PDFBool, PDFDocument, PDFName, PDFRawStream, type PDFImage, type PDFPage } from 'pdf-lib'
import { bakeRotationSpec } from './localEngineMath'

/**
 * 复刻 pdfcpu 的图片插值规则（model/image.go：宽或高 < 1000px → /Interpolate true，
 * 水印与图片导入通用）：渲染器放大位图时两边同为平滑插值，否则边缘出现
 * 锯齿差（image-to-pdf 放大 4.7 倍时曾差 3%）。
 */
export async function embedWithInterpolate(image: PDFImage): Promise<PDFImage> {
  await image.embed()
  if (image.width < 1000 || image.height < 1000) {
    const obj = image.doc.context.lookup(image.ref)
    if (obj instanceof PDFRawStream) obj.dict.set(PDFName.of('Interpolate'), PDFBool.True)
  }
  return image
}

/**
 * 把「页面自带 /Rotate + extraClockwiseDeg（顺时针，90 的倍数）」的总旋转烘进
 * 内容流：原内容包 q [R(−total)+T] cm … Q，MediaBox/CropBox 改写为交换后的
 * 视口框，删除 /Rotate。总角为 0 且无自带旋转时是 no-op；总角为 0 但自带
 * 非 0（如自带 180 再转 180）时只清 /Rotate（服务端包恒等 CTM，渲染等价）。
 */
export function bakePageRotation(doc: PDFDocument, page: PDFPage, extraClockwiseDeg = 0) {
  const auto = ((Math.round(page.getRotation().angle) % 360) + 360) % 360
  const total = (((auto + Math.round(extraClockwiseDeg)) % 360) + 360) % 360
  if (total === 0) {
    if (auto !== 0) page.node.delete(PDFName.of('Rotate'))
    return
  }
  const spec = bakeRotationSpec(total, page.getCropBox())
  if (!spec) throw new Error(`无法处理的页面旋转角: ${auto} + ${extraClockwiseDeg}`)

  const ctx = doc.context
  const [a, b, c, d, e, f] = spec.cm
  const pre = ctx.register(ctx.flateStream(`q ${a} ${b} ${c} ${d} ${e} ${f} cm\n`))
  const post = ctx.register(ctx.flateStream('\nQ'))
  const contents = page.node.get(PDFName.of('Contents'))
  const existing = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : []
  page.node.set(PDFName.of('Contents'), ctx.obj([pre, ...existing, post]))

  page.setMediaBox(spec.box.x, spec.box.y, spec.box.width, spec.box.height)
  page.setCropBox(spec.box.x, spec.box.y, spec.box.width, spec.box.height)
  page.node.delete(PDFName.of('Rotate'))
}
