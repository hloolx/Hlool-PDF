import type { ScanConfig } from '../../lib/types'

/**
 * 把「打印后扫描」的瑕疵(偏转、模糊、噪点、色偏)叠加到一帧已渲染的页面上,
 * 返回新画布,不修改源。噪点直接用 2D 圆点绘制,避免旧实现里
 * SVG blob → createImageBitmap 的额外一次编解码。
 */
export function applyScanEffect(
  source: HTMLCanvasElement | ImageBitmap,
  config: ScanConfig,
  options?: {
    /** 预览传 false:去掉逐页随机偏转,参数微调前后画面才可对比。 */
    randomize?: boolean
  }
): HTMLCanvasElement {
  const width = source.width
  const height = source.height
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')

  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, width, height)

  let filter = `blur(${config.blur}px)`
  if (config.colorspace === 'gray') filter += ' grayscale(1)'
  filter += ` brightness(${config.brightness}) sepia(${config.yellowish}) contrast(${config.contrast})`
  ctx.filter = filter

  const variance = options?.randomize === false ? 0 : config.rotateVariance
  const angle = ((config.rotate + variance * (Math.random() - 0.5)) * Math.PI) / 180
  ctx.translate(width / 2, height / 2)
  ctx.rotate(angle)
  ctx.translate(-width / 2, -height / 2)
  ctx.drawImage(source, 0, 0)

  // 噪点与边框画在未偏转的坐标系上(扫描仪的传感器噪声不随纸张歪斜)。
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.filter = 'none'
  drawNoise(ctx, config.noise, width, height)

  if (config.border) {
    ctx.strokeStyle = 'black'
    ctx.lineWidth = 1
    ctx.strokeRect(0, 0, width, height)
  }
  return canvas
}

function drawNoise(ctx: CanvasRenderingContext2D, intensity: number, width: number, height: number) {
  if (intensity <= 0) return
  const count = Math.max(1, Math.floor(intensity * 300))
  ctx.fillStyle = 'black'
  for (let i = 0; i < count; i++) {
    ctx.globalAlpha = Math.random() * intensity
    ctx.beginPath()
    ctx.arc(Math.random() * width, Math.random() * height, 0.5, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

export async function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('画布导出失败'))
      },
      mimeType,
      quality
    )
  })
}
