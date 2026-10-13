/** Limits protect browser memory; reaching one always stops the operation. */
export function assertWithinLocalLimit(state: { localMaxMB: number }, bytes: number, label = '文件'): void {
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error('无法确认文件大小，请重新导入文件。')
  if (state.localMaxMB > 0 && bytes > state.localMaxMB * 1024 * 1024) {
    throw new Error(`${label}超过 ${state.localMaxMB} MB 的本地处理上限。请拆分文件，或在设置中提高上限（0 表示不限）。`)
  }
}

/** Recognize only pdf-lib's specific encryption failure, without hiding parse errors. */
export function isEncryptedPdfError(error: unknown): boolean {
  // pdf-lib's ES5 Error subclass does not reliably preserve instanceof across bundles.
  return error instanceof Error && /Input document to .*PDFDocument\.load.* is encrypted\./.test(error.message)
}

/** Retain useful validation messages and give actionable explanations for engine errors. */
export function localProcessingError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  let explanation: string
  if (/password|encrypted/i.test(message)) {
    explanation = '无法解锁 PDF，请重新导入并输入正确的打开密码。'
  } else if (/out of memory|memory access out of bounds|allocation|array buffer allocation|invalid array length/i.test(message)) {
    explanation = '浏览器可用内存不足，请关闭其他标签页、拆分文件或降低扫描清晰度后重试。'
  } else if (/fetch|importing a module|loading chunk|load failed|wasm.*compile/i.test(message)) {
    explanation = '本地处理组件加载失败，请刷新页面后重试；离线使用前请先完成离线准备。'
  } else if (/invalid pdf|failed to parse pdf|no pdf header|expected.*pdf|xref|invalid object ref/i.test(message)) {
    explanation = '无法解析这份 PDF，请尝试从原软件重新导出 PDF 后导入。'
  } else if (/[\u3400-\u9fff]/.test(message)) {
    return error instanceof Error ? error : new Error(message)
  } else {
    explanation = `浏览器处理失败，请尝试重新导入或拆分文件。错误详情：${message}`
  }
  return new Error(explanation, { cause: error })
}
