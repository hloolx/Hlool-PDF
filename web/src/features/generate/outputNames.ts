/** Keep downloads and ZIP members as single filenames, regardless of template contents. */
export function safePdfBasename(name: string): string {
  const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').trim()
  const stem = safe.replace(/\.pdf$/i, '').replace(/[. ]+$/g, '').trim() || '文档'
  return `${stem}.pdf`
}

/** Sanitize before comparing so different path-like inputs cannot create duplicate ZIP entries. */
export function uniqueZipName(name: string, used: Set<string>): string {
  const safe = safePdfBasename(name)
  let candidate = safe
  for (let i = 2; used.has(candidate.toLowerCase()); i++) {
    candidate = safe.replace(/\.pdf$/i, '') + `-${i}.pdf`
  }
  used.add(candidate.toLowerCase())
  return candidate
}
