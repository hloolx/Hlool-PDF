/** 在当前浏览器中将接近白色的像素渐变变为透明，保留已有透明度。 */
export async function removeWhiteBackground(imageFile: Blob, threshold = 247): Promise<Blob> {
  const bitmap = await createImageBitmap(imageFile)
  try {
    if (bitmap.width * bitmap.height > 16_000_000) {
      throw new Error('图片超过 1600 万像素，请先缩小图片后重试。')
    }
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器无法创建画布，请换用支持 Canvas 的浏览器。')
    context.drawImage(bitmap, 0, 0)
    const image = context.getImageData(0, 0, canvas.width, canvas.height)
    const hardWhite = Math.max(200, Math.min(255, threshold))
    const softWhite = hardWhite - 15
    for (let i = 0; i < image.data.length; i += 4) {
      const brightness = Math.min(image.data[i], image.data[i + 1], image.data[i + 2])
      if (brightness >= hardWhite) image.data[i + 3] = 0
      else if (brightness > softWhite) {
        image.data[i + 3] = Math.round(image.data[i + 3] * (hardWhite - brightness) / 15)
      }
    }
    context.putImageData(image, 0, 0)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法生成透明 PNG，请重试。')), 'image/png')
    })
  } finally {
    bitmap.close()
  }
}
