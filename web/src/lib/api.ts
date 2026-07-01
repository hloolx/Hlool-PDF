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

export async function putJSON<T>(url: string, body: unknown): Promise<T> {
  return parseJSON<T>(
    await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  )
}

export async function patchJSON<T>(url: string, body: unknown): Promise<T> {
  return parseJSON<T>(
    await fetch(url, {
      method: 'PATCH',
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

/** POST 一个 multipart 表单，期望响应体是二进制（如成品 PDF）；出错时解析 JSON 错误。 */
export async function postFormBlob(url: string, form: FormData): Promise<Blob> {
  const res = await fetch(url, { method: 'POST', body: form })
  if (!res.ok) {
    let code: string | undefined
    let message = res.statusText || 'Request failed'
    try {
      const body = (await res.json()) as { error?: unknown; code?: unknown }
      if (body.error) message = String(body.error)
      if (body.code) code = String(body.code)
    } catch {
      /* 非 JSON 错误体：用状态文本 */
    }
    throw new ApiError(localizeError(message), res.status, code)
  }
  return res.blob()
}

export async function getBlob(url: string): Promise<Blob> {
  const res = await fetch(url)
  if (!res.ok) throw new ApiError(res.statusText || '请求失败', res.status)
  return res.blob()
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
    'authentication required': '请先登录。',
    'admin privileges required': '需要管理员权限。',
    'incorrect username or password': '用户名或密码不正确。',
    'registration is closed': '当前实例未开放注册。',
    'registration invite is required': '请输入邀请码。',
    'registration invite is invalid': '邀请码无效。',
    'registration invite is disabled': '邀请码已被禁用。',
    'registration invite is used': '邀请码已用完。',
    'registration invite is expired': '邀请码已过期。',
    'registration invite is unavailable': '邀请码暂不可用，请换一个重试。',
    'too many attempts, please try again later': '尝试次数过多，请稍后再试。',
    'server is busy, please retry shortly': '服务器繁忙，请稍后重试。',
    'seam seal needs at least two pages': '骑缝章至少需要 2 页。',
    'seam seal size is out of range': '骑缝章尺寸超出允许范围。',
    'seam seal margin is out of range': '骑缝章边距超出允许范围。',
    'seam seal max slices is out of range': '骑缝章最大切片数超出允许范围。',
    'a PDF file is required': '请先选择 PDF 文件。',
    'at least one page is required': '至少需要一页。',
    'at least one stamp or seam seal is required': '请先放置印章或启用骑缝章。',
    'a referenced stamp was not found': '引用的印章不存在，请重新选择。',
    'PDF password is required': '该 PDF 受密码保护，请输入打开密码。',
    'PDF password is incorrect': 'PDF 密码不正确，请重试。',
    'only PNG and JPG stamp images are supported': '只支持 PNG / JPG 印章图片。',
    'invalid stamp id': '印章标识无效。'
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
  return text
}
