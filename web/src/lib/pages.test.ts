import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_PAGE_SELECTION, parsePageExpression } from './pages'

test('page expressions reject malformed ranges, scientific notation and unsafe integers', () => {
  for (const value of ['1-2-3', '1e2', '0x10', '+1', '1.5', '9007199254740992']) {
    assert.deepEqual(parsePageExpression(value, Number.MAX_SAFE_INTEGER), { pages: [], invalidParts: [value] })
  }
  assert.deepEqual(parsePageExpression('3-1，5,2', 5), { pages: [1, 2, 3, 5], invalidParts: [] })
})

test('large ranges and invalid document counts are bounded before allocating or looping', () => {
  assert.equal(parsePageExpression('1-1000000000', Number.MAX_SAFE_INTEGER).pages.length, 0)
  assert.equal(parsePageExpression('全部', MAX_PAGE_SELECTION + 1).pages.length, 0)
  for (const count of [NaN, Infinity, -1, 1.5, 0]) {
    assert.equal(parsePageExpression('全部', count).invalidParts.length, 1)
  }
  const union = parsePageExpression(`1-${MAX_PAGE_SELECTION},${MAX_PAGE_SELECTION + 1}`, MAX_PAGE_SELECTION + 1)
  assert.equal(union.pages.length, MAX_PAGE_SELECTION)
  assert.deepEqual(union.invalidParts, [`${MAX_PAGE_SELECTION + 1}`])
})
