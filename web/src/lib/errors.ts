export function errorText(err: unknown) {
  return localizeError(err instanceof Error ? err.message : String(err))
}

export function localizeError(value: string) {
  const text = value.trim()
  const lower = text.toLowerCase()
  const exact: Record<string, string> = {
    'seam seal needs at least two pages': '骑缝章至少需要 2 页。',
    'seam seal size is out of range': '骑缝章尺寸超出允许范围。',
    'seam seal margin is out of range': '骑缝章边距超出允许范围。',
    'seam seal max slices is out of range': '骑缝章最大切片数超出允许范围。',
    'seam seal page expression is too long': '骑缝章页面范围表达式过长。',
    'invalid seam seal side': '骑缝章方位无效。',
    'seam seal contains an invalid number': '骑缝章参数包含无效数值。',
    'seam seal position must be between 0 and 100': '骑缝章位置需在 0 到 100 之间。',
    'seam seal opacity must be between 0 and 1': '骑缝章不透明度需在 0 到 1 之间。',
    'a PDF file is required': '请先选择 PDF 文件。',
    'a PDF file could not be read': '有一个 PDF 文件无法读取。',
    'at least one page is required': '至少需要一页。',
    'a referenced stamp was not found': '引用的印章不存在，请重新选择。',
    'PDF password is required': '该 PDF 受密码保护，请输入打开密码。',
    'PDF password is incorrect': 'PDF 密码不正确，请重试。',
    'only PNG and JPG stamp images are supported': '只支持 PNG / JPG 印章图片。',
    'unsupported image; only PNG and JPG are allowed': '只支持 PNG / JPG 图片。',
    'stamp image dimensions are too large': '印章图片尺寸过大。',
    'invalid stamp id': '印章标识无效。',
    'stamp height must match the image aspect ratio': '印章宽高比与图片不一致，请删除后重新放置。',
    'stamp width and height must be greater than zero': '印章尺寸必须大于零。',
    'stamp rotation must be between -180 and 180': '印章旋转角度需在 -180 到 180 之间。',
    'stamp opacity must be between 0 and 1': '印章不透明度需在 0 到 1 之间。',
    'stamp placement contains an invalid number': '印章参数包含无效数值。',
    'rotation must be a multiple of 90 degrees': '页面旋转角度必须是 90 的倍数。',
    'output name is too long': '输出文件名过长。',
    'invalid parameters': '处理参数无效。',
    'image dimensions are out of range': '图片尺寸超出允许范围。',
    'the PDF could not be opened': '该 PDF 无法打开。',
    'the PDF could not be read': '该 PDF 无法读取。'
  }
  if (exact[text]) return exact[text]
  if (exact[lower]) return exact[lower]

  let match = text.match(/^page (\d+) is out of range$/i)
  if (match) return `第 ${match[1]} 页超出范围。`
  match = text.match(/^invalid page range "(.+)"$/i)
  if (match) return `页面范围“${match[1]}”无效。`
  match = text.match(/^invalid page "(.+)"$/i)
  if (match) return `页码“${match[1]}”无效。`
  match = text.match(/^stamp on page (\d+) is too large$/i)
  if (match) return `第 ${match[1]} 页的印章过大。`
  match = text.match(/^stamp on page (\d+) is outside the allowed coordinate range$/i)
  if (match) return `第 ${match[1]} 页的印章超出页面允许范围。`
  match = text.match(/^too many source files; max is (\d+)$/i)
  if (match) return `源文件数量过多，最多 ${match[1]} 个。`
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
