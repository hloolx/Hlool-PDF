// API client for AI matting service
export async function mattingPreview(imageFile: File): Promise<string> {
  const formData = new FormData()
  formData.append('image', imageFile)

  const response = await fetch('/api/ai/matting', {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    if (body.code === 'matting_not_configured') {
      throw new Error('AI 背景移除服务未配置，请联系管理员')
    }
    if (body.code === 'matting_failed') {
      throw new Error('背景移除失败：' + (body.error || '未知错误'))
    }
    throw new Error('请求失败：' + response.statusText)
  }

  const data = await response.json()
  return data.b64_json
}

export function base64ToBlob(base64: string, mimeType = 'image/png'): Blob {
  const byteString = atob(base64)
  const ab = new ArrayBuffer(byteString.length)
  const ia = new Uint8Array(ab)
  for (let i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i)
  }
  return new Blob([ab], { type: mimeType })
}
