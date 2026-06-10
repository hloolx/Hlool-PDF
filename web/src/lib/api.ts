export class ApiError extends Error {
  status: number
  code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function parseJSON<T>(res: Response): Promise<T> {
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      if (!res.ok) throw new ApiError(localizeError(text), res.status)
      throw new ApiError('预期返回 JSON 响应', res.status)
    }
  }
  if (!res.ok) {
    const body = (typeof data === 'object' && data ? data : {}) as { error?: unknown; code?: unknown }
    const message = body.error ? String(body.error) : res.statusText || 'Request failed'
    throw new ApiError(localizeError(message), res.status, body.code ? String(body.code) : undefined)
  }
  return data as T
}

export async function getJSON<T>(url: string): Promise<T> {
  return parseJSON<T>(await fetch(url))
}

export async function postJSON<T>(url: string, body: unknown): Promise<T> {
  return parseJSON<T>(
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  )
}

export async function deleteJSON<T = { status: string }>(url: string): Promise<T> {
  return parseJSON<T>(await fetch(url, { method: 'DELETE' }))
}

export async function upload<T>(url: string, file: Blob, name: string, fields?: Record<string, string>): Promise<T> {
  const body = new FormData()
  body.append('file', file, name)
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value) body.append(key, value)
  }
  return parseJSON<T>(await fetch(url, { method: 'POST', body }))
}

export function errorText(err: unknown) {
  return localizeError(err instanceof Error ? err.message : String(err))
}

export function errorCode(err: unknown) {
  return err instanceof ApiError ? err.code : undefined
}

export function localizeError(value: string) {
  const text = value.trim()
  const lower = text.toLowerCase()
  const exact: Record<string, string> = {
    'Expected JSON response': '预期返回 JSON 响应',
    'Request failed': '请求失败',
    'method not allowed': '请求方法不被支持。',
    'request origin is not allowed': '当前请求来源不被允许。',
    'seam seal needs at least two pages': '骑缝章至少需要 2 页。',
    'seam seal size is out of range': '骑缝章尺寸超出允许范围。',
    'seam seal margin is out of range': '骑缝章边距超出允许范围。',
    'seam seal max slices is out of range': '骑缝章最大切片数超出允许范围。',
    'PDF file not found': '找不到该 PDF 文件。',
    'only PDF files are supported': '只支持 PDF 与 PNG / JPG / WebP 图片文件。',
    'image dimensions are out of range': '图片尺寸超出允许范围。',
    'at least one page is required': '至少需要一页。',
    'at least one stamp or seam seal is required': '请先放置印章或启用骑缝章。',
    'too many PDF jobs are already running': '处理任务已排满，请稍候重试。',
    'PDF password is required': '该 PDF 受密码保护，请输入打开密码。',
    'PDF password is incorrect': 'PDF 密码不正确，请重试。'
  }
  if (exact[text]) return exact[text]
  if (exact[lower]) return exact[lower]

  let match = text.match(/^page (\d+) is out of range$/i)
  if (match) return `第 ${match[1]} 页超出范围。`
  match = text.match(/^invalid page range "(.+)"$/i)
  if (match) return `页面范围“${match[1]}”无效。`
  match = text.match(/^too many seam seals; max is (\d+)$/i)
  if (match) return `骑缝章数量过多，最多 ${match[1]} 个。`
  match = text.match(/^too many stamp placements; max is (\d+)$/i)
  if (match) return `印章数量过多，最多 ${match[1]} 个。`
  match = text.match(/^too many pages for one seam seal; max is (\d+)$/i)
  if (match) return `单个骑缝章页数过多，最多 ${match[1]} 页。`
  match = text.match(/^PDF has too many pages; max is (\d+)$/i)
  if (match) return `PDF 页数过多，最多 ${match[1]} 页。`
  match = text.match(/^too many pages to compose; max is (\d+)$/i)
  if (match) return `拼接页数过多，最多 ${match[1]} 页。`
  match = text.match(/^unsupported image: /i)
  if (match) return '无法识别的图片内容，请使用 PNG / JPG / WebP。'
  match = text.match(/^stamp on page (\d+) is outside the allowed coordinate range$/i)
  if (match) return `第 ${match[1]} 页的印章位置超出允许范围。`
  return text
}
