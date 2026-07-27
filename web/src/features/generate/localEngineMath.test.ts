/**
 * 钉死本地引擎三个语义点（LOCAL_FIRST.md P1-2a/b/c）与 /Rotate 烘录矩阵。
 * 由对齐 harness 驱动：esbuild 打包后用 node --test 运行
 * （scripts/verify-local-engine.mjs 的 unit 阶段），不进 Vite 产物。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bakeRotationSpec, normalizedOpacity, placementDraw, serverPageDim } from './localEngineMath'

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps

test('a) 锚点：rot=0 时左下角 = 视口LL + (xPt,yPt)', () => {
  const d = placementDraw({ xPt: 30, yPt: 40, widthPt: 100, rotation: 0 }, 200, 80, 5, 7)
  assert.ok(close(d.x, 35) && close(d.y, 47), `${d.x},${d.y}`)
  assert.equal(d.rotateDeg, -0)
})

test('c) 缩放：宽 = widthPt，高按图片纵横比（不读 heightPt）', () => {
  const d = placementDraw({ xPt: 0, yPt: 0, widthPt: 100, rotation: 0 }, 200, 80, 0, 0)
  assert.ok(close(d.width, 100) && close(d.height, 40))
})

test('b) 旋转绕中心：任意角下中心是不动点', () => {
  for (const rotation of [-180, -90, -37, 0, 15, 37, 90, 120]) {
    const d = placementDraw({ xPt: 30, yPt: 40, widthPt: 100, rotation }, 200, 80, 0, 0)
    const theta = (d.rotateDeg * Math.PI) / 180
    // pdf-lib 语义：图片左下角落在 (x,y)，绕该点转 theta。反推中心位置：
    const cx = d.x + (d.width / 2) * Math.cos(theta) - (d.height / 2) * Math.sin(theta)
    const cy = d.y + (d.width / 2) * Math.sin(theta) + (d.height / 2) * Math.cos(theta)
    assert.ok(close(cx, 30 + 50) && close(cy, 40 + 20), `rot=${rotation}: center ${cx},${cy}`)
  }
})

test('b) 旋转方向：正 rotation（屏幕顺时针）→ pdf 逆时针取负，唯一取负点', () => {
  const d = placementDraw({ xPt: 0, yPt: 0, widthPt: 100, rotation: 37 }, 100, 100, 0, 0)
  assert.equal(d.rotateDeg, -37)
  // 顺时针小角度时，图片右上角应当往下走：验证方向没有二次取负。
  const theta = (d.rotateDeg * Math.PI) / 180
  const cornerY = d.y + d.width * Math.sin(theta) + d.height * Math.cos(theta)
  assert.ok(cornerY < 100, `top-right y=${cornerY} should drop below 100`)
})

test('opacity 归一化与服务端 normalizedOpacity 一致', () => {
  assert.equal(normalizedOpacity(0.5), 0.5)
  assert.equal(normalizedOpacity(0), 1)
  assert.equal(normalizedOpacity(-1), 1)
  assert.equal(normalizedOpacity(1.5), 1)
  assert.equal(normalizedOpacity(NaN), 1)
})

test('/Rotate 烘录矩阵与 pdfcpu ContentBytesForPageRotation 一致', () => {
  const crop = { x: 0, y: 0, width: 595, height: 842 }
  const b90 = bakeRotationSpec(90, crop)!
  assert.deepEqual(b90.cm, [0, -1, 1, 0, 0, 595])
  assert.deepEqual(b90.box, { x: 0, y: 0, width: 842, height: 595 })
  const b180 = bakeRotationSpec(180, crop)!
  assert.deepEqual(b180.cm, [-1, 0, 0, -1, 595, 842])
  const b270 = bakeRotationSpec(270, crop)!
  assert.deepEqual(b270.cm, [0, 1, -1, 0, 842, 0])
  assert.deepEqual(b270.box.width, 842)
  assert.equal(bakeRotationSpec(0, crop), null)
  assert.equal(bakeRotationSpec(45, crop), null)
  // 负角与 >360 归一
  assert.deepEqual(bakeRotationSpec(-90, crop)!.cm, [0, 1, -1, 0, 842, 0])
  assert.deepEqual(bakeRotationSpec(450, crop)!.cm, [0, -1, 1, 0, 0, 595])
})

test('/Rotate 烘录后原内容四角映射正确（90°：左下→左上）', () => {
  const { cm } = bakeRotationSpec(90, { x: 0, y: 0, width: 595, height: 842 })!
  const apply = (px: number, py: number) => [px * cm[0] + py * cm[2] + cm[4], px * cm[1] + py * cm[3] + cm[5]]
  assert.deepEqual(apply(0, 0), [0, 595]) // 原左下 → 新页左上
  assert.deepEqual(apply(595, 0), [0, 0]) // 原右下 → 新页左下
  assert.deepEqual(apply(0, 842), [842, 595]) // 原左上 → 新页右上
})

test('serverPageDim 镜像 pdfcpu PageDims（±90 交换）', () => {
  assert.deepEqual(serverPageDim(595, 842, 0), { widthPt: 595, heightPt: 842 })
  assert.deepEqual(serverPageDim(595, 842, 90), { widthPt: 842, heightPt: 595 })
  assert.deepEqual(serverPageDim(595, 842, 180), { widthPt: 595, heightPt: 842 })
  assert.deepEqual(serverPageDim(595, 842, -90), { widthPt: 842, heightPt: 595 })
})
