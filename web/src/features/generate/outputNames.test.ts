import assert from 'node:assert/strict'
import { test } from 'node:test'
import { safePdfBasename, uniqueZipName } from './outputNames'

test('ZIP filenames strip separators and control characters, then deduplicate the resulting basename', () => {
  const used = new Set<string>()
  const names = ['../合同/附件.pdf', '..\\合同\\附件.pdf', '.._合同_附件.PDF', 'bad\0name.pdf'].map((name) => uniqueZipName(name, used))
  assert.deepEqual(names, ['.._合同_附件.pdf', '.._合同_附件-2.pdf', '.._合同_附件-3.pdf', 'bad_name.pdf'])
  assert.ok(names.every((name) => !/[\\/\u0000-\u001f\u007f]/.test(name)))
  assert.equal(safePdfBasename(' .. '), '文档.pdf')
  assert.equal(safePdfBasename('报告'), '报告.pdf')
  assert.equal(safePdfBasename('报告.PDF'), '报告.pdf')
})
