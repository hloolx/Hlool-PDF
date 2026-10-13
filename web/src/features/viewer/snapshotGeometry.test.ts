import assert from 'node:assert/strict'
import { test } from 'node:test'
import { snapshotContentTransform, stampedSnapshotGeometry } from './snapshotGeometry'

function point(matrix: number[], x: number, y: number) {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]
}

test('rotated stamped pages use output dimensions and the baked content coordinates', () => {
  const box = { x: 0, y: 0, width: 595, height: 842 }
  const geometry = stampedSnapshotGeometry({ crop: box, media: box, rotation: 90 }, 1)
  assert.deepEqual(geometry.view, { x: 0, y: 0, width: 842, height: 595 })
  const matrix = snapshotContentTransform(geometry, 1)
  assert.deepEqual(point(matrix, 0, 0), [0, 0])
  assert.deepEqual(point(matrix, 595, 842), [842, 595])
})

test('cropped pages retain separate visible, stamp-origin and seam-placement boxes', () => {
  const geometry = stampedSnapshotGeometry({
    crop: { x: 30, y: 40, width: 500, height: 700 },
    media: { x: 0, y: 0, width: 595, height: 842 },
    rotation: 0
  }, 1)
  assert.deepEqual(geometry.view, { x: 30, y: 40, width: 500, height: 700 })
  assert.deepEqual(geometry.seamSize, { widthPt: 595, heightPt: 842 })
  assert.deepEqual(point(snapshotContentTransform(geometry, 1), 30, 740), [0, 0])
  assert.deepEqual(point(snapshotContentTransform(geometry, 1), 530, 40), [500, 700])
})

test('offset cropped rotation and UserUnit preserve the engine content translation', () => {
  const geometry = stampedSnapshotGeometry({
    crop: { x: 30, y: 40, width: 500, height: 700 },
    media: { x: 0, y: 0, width: 595, height: 842 },
    rotation: 90
  }, 2)
  assert.deepEqual(geometry.view, { x: 30, y: 40, width: 700, height: 500 })
  assert.deepEqual(geometry.seamSize, { widthPt: 842, heightPt: 595 })
  // Engine baking retains CropBox's lower-left but rotates content about zero.
  assert.deepEqual(point(snapshotContentTransform(geometry, 1), 30, 40), [20, 140])
})
