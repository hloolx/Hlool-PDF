import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PDFDocument, degrees } from 'pdf-lib'
import { composePdfLocally, imageToPdfLocally } from './localCompose'

async function fixture(sizes: [number, number][], rotate = 0) {
  const doc = await PDFDocument.create()
  for (const size of sizes) doc.addPage(size).setRotation(degrees(rotate))
  return new Blob([await doc.save() as BlobPart], { type: 'application/pdf' })
}

test('compose preserves interleaved source order, duplicates, rotation and per-source password slots', async () => {
  const sources = [await fixture([[200, 300], [400, 500]]), await fixture([[600, 700]])]
  const result = await composePdfLocally(sources, [
    { file: 0, pageNumber: 2 },
    { file: 1, pageNumber: 1 },
    { file: 0, pageNumber: 1, rotate: 90 },
    { file: 0, pageNumber: 1 }
  ], [undefined, 'unused-for-unencrypted-source'])
  const output = await PDFDocument.load(result)
  assert.deepEqual(output.getPages().map((page) => [page.getWidth(), page.getHeight(), page.getRotation().angle]), [
    [400, 500, 0], [600, 700, 0], [300, 200, 0], [200, 300, 0]
  ])
  const original = await PDFDocument.load(await sources[0].arrayBuffer())
  assert.deepEqual([original.getPage(0).getWidth(), original.getPage(0).getHeight()], [200, 300])
})

test('compose validates page numbers and rotation before reading source bytes', async () => {
  const unreadable = { arrayBuffer() { throw new Error('must not read') } } as unknown as Blob
  for (const pages of [
    [{ file: 0, pageNumber: 0 }],
    [{ file: 1, pageNumber: 1 }],
    [{ file: NaN, pageNumber: 1 }],
    [{ file: 0, pageNumber: 1.5 }],
    [{ file: 0, pageNumber: 1, rotate: 89.9 }]
  ]) await assert.rejects(composePdfLocally([unreadable], pages), /页码|源文件|旋转角/)
})

test('compose skips unused sources and refuses out-of-range pages or damaged PDFs', async () => {
  const valid = await fixture([[200, 300]])
  const damaged = new Blob(['not a PDF'])
  const result = await composePdfLocally([valid, damaged], [{ file: 0, pageNumber: 1 }])
  assert.equal((await PDFDocument.load(result)).getPageCount(), 1)
  await assert.rejects(composePdfLocally([valid], [{ file: 0, pageNumber: 2 }]), /页码越界/)
  await assert.rejects(composePdfLocally([damaged], [{ file: 0, pageNumber: 1 }], 'wrong-password'), /No PDF header/)
})

test('image conversion produces one A4 page and rejects unsupported bytes', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
  const result = await imageToPdfLocally(new Blob([png], { type: 'image/png' }))
  const output = await PDFDocument.load(result)
  assert.equal(output.getPageCount(), 1)
  assert.equal(output.getPage(0).getWidth(), 595.27)
  assert.equal(output.getPage(0).getHeight(), 841.89)
  await assert.rejects(imageToPdfLocally(new Blob(['not a supported image'])), /不支持的图片格式/)
})
