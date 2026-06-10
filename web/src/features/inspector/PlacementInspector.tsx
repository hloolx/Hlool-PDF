import { Move, Stamp, Trash2 } from 'lucide-react'
import { parsePageExpression } from '../../lib/pages'
import { clamp, type PDFFile, type Placement } from '../../lib/types'
import { mmToPt, ptToMm } from '../../lib/units'
import { useEditorStore } from '../../state/store'
import { Button } from '../../ui/Button'
import { Field, NumberField } from '../../ui/Field'
import { Section } from '../../ui/Section'
import { Slider } from '../../ui/Slider'
import { applyPlacementToPages, centerPlacement, resizePlacement } from '../placements/actions'
import { RangeInput } from './RangeInput'

/** 选中印章后的检查器：精确数值与“应用到范围”。 */
export function PlacementInspector({ placement, file }: { placement: Placement; file: PDFFile }) {
  const update = useEditorStore((state) => state.updatePlacement)
  const remove = useEditorStore((state) => state.removePlacement)
  const rangeText = useEditorStore((state) => state.rangeText)
  const stamps = useEditorStore((state) => state.stamps)
  const stampMeta = useEditorStore((state) => state.stampMeta)
  const pageInfo = file.pages.find((p) => p.pageNumber === placement.pageNumber)
  if (!pageInfo) return null

  const stamp = stamps.find((s) => s.stampId === placement.stampId)
  const stampName = stamp ? stampMeta[stamp.stampId]?.alias || stamp.name : '印章'
  const rangePages = parsePageExpression(rangeText, file.pageCount).pages
  const xMm = ptToMm(placement.xPt)
  const yTopMm = ptToMm(pageInfo.heightPt - placement.yPt - placement.heightPt)

  return (
    <div>
      <div className="flex items-center gap-2.5 border-b border-line/70 py-3">
        {stamp && (
          <span className="checker flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line">
            <img src={stamp.url} alt="" className="max-h-full max-w-full p-1" />
          </span>
        )}
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium" title={stampName}>
            {stampName}
          </p>
          <p className="tnum text-xs text-ink-muted">第 {placement.pageNumber} 页</p>
        </div>
      </div>

      <Section title="尺寸与角度">
        <div className="grid grid-cols-2 gap-2">
          <Field label="宽度">
            <NumberField
              value={ptToMm(placement.widthPt)}
              min={5}
              max={150}
              unit="mm"
              onChange={(mm) => resizePlacement(placement, pageInfo, mmToPt(mm))}
            />
          </Field>
          <Field label="旋转">
            <NumberField
              value={placement.rotation}
              min={-180}
              max={180}
              unit="°"
              onChange={(rotation) => update(placement.id, { rotation })}
            />
          </Field>
        </div>
        <Field label={`不透明度 ${Math.round(placement.opacity * 100)}%`}>
          <Slider
            value={Math.round(placement.opacity * 100)}
            min={10}
            max={100}
            onChange={(value) => update(placement.id, { opacity: value / 100 })}
          />
        </Field>
      </Section>

      <Section title="位置" defaultOpen={false}>
        <div className="grid grid-cols-2 gap-2">
          <Field label="距左边">
            <NumberField
              value={xMm}
              min={0}
              max={ptToMm(Math.max(0, pageInfo.widthPt - placement.widthPt))}
              unit="mm"
              onChange={(mm) =>
                update(placement.id, { xPt: clamp(mmToPt(mm), 0, Math.max(0, pageInfo.widthPt - placement.widthPt)) })
              }
            />
          </Field>
          <Field label="距顶边">
            <NumberField
              value={yTopMm}
              min={0}
              max={ptToMm(Math.max(0, pageInfo.heightPt - placement.heightPt))}
              unit="mm"
              onChange={(mm) =>
                update(placement.id, {
                  yPt: clamp(
                    pageInfo.heightPt - mmToPt(mm) - placement.heightPt,
                    0,
                    Math.max(0, pageInfo.heightPt - placement.heightPt)
                  )
                })
              }
            />
          </Field>
        </div>
        <Button onClick={() => centerPlacement(placement)}>
          <Move size={16} />
          页面居中
        </Button>
      </Section>

      <Section title="应用到其他页">
        <RangeInput />
        <Button
          variant="primary"
          disabled={rangePages.length === 0}
          onClick={() => applyPlacementToPages(placement, rangePages)}
        >
          <Stamp size={16} />
          按相同位置应用
        </Button>
      </Section>

      <div className="py-3">
        <Button variant="danger" className="w-full" onClick={() => remove(placement.id)}>
          <Trash2 size={16} />
          删除该印章
        </Button>
      </div>
    </div>
  )
}
