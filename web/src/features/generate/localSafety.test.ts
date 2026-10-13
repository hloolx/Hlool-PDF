import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertWithinLocalLimit, localProcessingError } from './localSafety'

test('limit stops oversized inputs and explains how to proceed; zero permits larger inputs', () => {
  assert.doesNotThrow(() => assertWithinLocalLimit({ localMaxMB: 1 }, 1024 * 1024))
  assert.throws(() => assertWithinLocalLimit({ localMaxMB: 1 }, 1024 * 1024 + 1, '待合并文件'), /待合并文件.*超过.*设置.*0 表示不限/)
  assert.doesNotThrow(() => assertWithinLocalLimit({ localMaxMB: 0 }, 2 ** 40))
  assert.throws(() => assertWithinLocalLimit({ localMaxMB: 0 }, NaN), /重新导入/)
})

test('processing errors preserve actionable validation and retain engine causes', () => {
  const validation = new Error('骑缝章至少需要 2 页')
  assert.equal(localProcessingError(validation), validation)
  const engine = new Error('WebAssembly: memory access out of bounds')
  const translated = localProcessingError(engine)
  assert.match(translated.message, /内存不足.*拆分/)
  assert.equal(translated.cause, engine)
  assert.match(localProcessingError(new Error('Input document is encrypted')).message, /正确的打开密码/)
  assert.match(localProcessingError(new Error('Failed to fetch dynamically imported module')).message, /组件加载失败/)
  assert.match(localProcessingError(new Error('No PDF header found')).message, /重新导出 PDF/)
})
