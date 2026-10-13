import { bakeRotationSpec, type PageBox, serverPageDim } from '../generate/localEngineMath'

export type SourcePageGeometry = { crop: PageBox; media: PageBox; rotation: number }
export type SnapshotGeometry = {
  view: PageBox
  stampBox: PageBox
  seamSize: { widthPt: number; heightPt: number }
  contentTransform: [number, number, number, number, number, number]
  userUnit: number
}

/** Mirror the boxes and content transform used when localEngine stamps a page. */
export function stampedSnapshotGeometry(source: SourcePageGeometry, userUnit: number): SnapshotGeometry {
  const baked = bakeRotationSpec(source.rotation, source.crop)
  const stampBox = baked?.box ?? source.crop
  const media = baked?.box ?? source.media
  const x = Math.max(stampBox.x, media.x)
  const y = Math.max(stampBox.y, media.y)
  const right = Math.min(stampBox.x + stampBox.width, media.x + media.width)
  const top = Math.min(stampBox.y + stampBox.height, media.y + media.height)
  // PDF.js displays the CropBox/MediaBox intersection, falling back to MediaBox
  // when they do not intersect. Stamp coordinates remain relative to CropBox.
  const view = right > x && top > y ? { x, y, width: right - x, height: top - y } : media
  return {
    view,
    stampBox,
    seamSize: serverPageDim(source.media.width, source.media.height, source.rotation),
    contentTransform: baked?.cm ?? [1, 0, 0, 1, 0, 0],
    userUnit
  }
}

/** PDF content -> output canvas, including the engine's rotation baking. */
export function snapshotContentTransform(geometry: SnapshotGeometry, scale: number): number[] {
  const { view, contentTransform: [a, b, c, d, e, f] } = geometry
  const s = scale * geometry.userUnit
  return [s * a, -s * b, s * c, -s * d, s * (e - view.x), s * (view.y + view.height - f)]
}
