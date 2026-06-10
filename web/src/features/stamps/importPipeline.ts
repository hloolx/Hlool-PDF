/**
 * 印章导入管线（纯前端）：
 * - WebP 等格式统一转码为 PNG 再上传（后端只需支持 PNG/JPG）。
 * - 不带透明通道的图片自动“白底透明化”（高亮度像素渐变去除），可一键撤销。
 */
export type PreparedStamp = {
  blob: Blob
  name: string
  whitened: boolean
  original: File
}

const HARD_WHITE = 247
const SOFT_WHITE = 232

function hasAlpha(image: ImageData) {
  const data = image.data
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) return true
  }
  return false
}

function whiten(image: ImageData) {
  const data = image.data
  for (let i = 0; i < data.length; i += 4) {
    const brightness = Math.min(data[i], data[i + 1], data[i + 2])
    if (brightness >= HARD_WHITE) {
      data[i + 3] = 0
    } else if (brightness >= SOFT_WHITE) {
      data[i + 3] = Math.round((data[i + 3] * (HARD_WHITE - brightness)) / (HARD_WHITE - SOFT_WHITE))
    }
  }
}

export async function prepareStamp(file: File, options?: { whiten?: boolean }): Promise<PreparedStamp> {
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建画布')
    context.drawImage(bitmap, 0, 0)

    const isNativeFormat = file.type === 'image/png' || file.type === 'image/jpeg'
    let whitened = false
    if (options?.whiten !== false && bitmap.width * bitmap.height <= 16_000_000) {
      const image = context.getImageData(0, 0, canvas.width, canvas.height)
      if (!hasAlpha(image)) {
        whiten(image)
        context.putImageData(image, 0, 0)
        whitened = true
      }
    }

    if (!whitened && isNativeFormat) {
      return { blob: file, name: file.name, whitened: false, original: file }
    }

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('无法导出 PNG'))), 'image/png')
    })
    const base = file.name.replace(/\.[^.]+$/, '') || 'stamp'
    return { blob, name: `${base}.png`, whitened, original: file }
  } finally {
    bitmap.close()
  }
}
