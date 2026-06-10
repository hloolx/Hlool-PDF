import { useState } from 'react'
import { ChevronDown, Stamp } from 'lucide-react'
import { mmToPt } from '../../lib/units'
import { useEditorStore } from '../../state/store'
import { Button } from '../../ui/Button'
import { Field, NumberField } from '../../ui/Field'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../ui/Menu'
import { Switch } from '../../ui/Switch'
import { batchStamp, type NineAnchor } from '../placements/actions'
import { NineGrid } from './NineGrid'

/** 批量盖章：九宫格定位 + 范围（复用全局页面范围）+ 轻微随机。 */
export function BatchPanel() {
  const stamps = useEditorStore((state) => state.stamps)
  const lastStampId = useEditorStore((state) => state.lastStampId)
  const rangeText = useEditorStore((state) => state.rangeText)
  const fileReady = useEditorStore((state) => state.activeFileId !== null)
  const stampMeta = useEditorStore((state) => state.stampMeta)
  const labelOf = (id: string) => {
    const stamp = stamps.find((s) => s.stampId === id)
    return stamp ? stampMeta[stamp.stampId]?.alias || stamp.name : ''
  }

  const [stampId, setStampId] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<NineAnchor>('bottomRight')
  const [marginXMm, setMarginXMm] = useState(15)
  const [marginYMm, setMarginYMm] = useState(15)
  const [randomEnabled, setRandomEnabled] = useState(false)
  const [randomOffsetMm, setRandomOffsetMm] = useState(1)
  const [randomRotationDeg, setRandomRotationDeg] = useState(2)

  const effectiveStampId = stampId ?? lastStampId ?? stamps[0]?.stampId ?? null
  const effectiveStamp = stamps.find((s) => s.stampId === effectiveStampId) ?? null
  const disabled = !fileReady || !effectiveStamp

  return (
    <div className="grid gap-3">
      <Field label="使用印章">
        <Menu>
          <MenuTrigger asChild>
            <Button className="w-full justify-between" disabled={stamps.length === 0}>
              <span className="flex min-w-0 items-center gap-2">
                {effectiveStamp && (
                  <img src={effectiveStamp.url} alt="" className="size-5 shrink-0 object-contain" />
                )}
                <span className="truncate">{effectiveStamp ? labelOf(effectiveStamp.stampId) : '请先导入印章'}</span>
              </span>
              <ChevronDown size={16} className="shrink-0 text-ink-muted" />
            </Button>
          </MenuTrigger>
          <MenuContent align="start" className="max-h-72 overflow-y-auto">
            {stamps.map((stamp) => (
              <MenuItem key={stamp.stampId} onSelect={() => setStampId(stamp.stampId)}>
                <img src={stamp.url} alt="" className="size-5 object-contain" />
                <span className="truncate">{labelOf(stamp.stampId)}</span>
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      </Field>
      <div className="flex items-start gap-3">
        <NineGrid value={anchor} onChange={setAnchor} />
        <div className="grid flex-1 gap-2">
          <Field label="水平边距">
            <NumberField value={marginXMm} min={0} max={100} unit="mm" onChange={setMarginXMm} disabled={anchor === 'center'} />
          </Field>
          <Field label="垂直边距">
            <NumberField value={marginYMm} min={0} max={100} unit="mm" onChange={setMarginYMm} disabled={anchor === 'center'} />
          </Field>
        </div>
      </div>
      <label className="flex items-center justify-between gap-2">
        <span className="text-xs text-ink-muted">轻微随机（更接近手工盖章）</span>
        <Switch checked={randomEnabled} onChange={setRandomEnabled} />
      </label>
      {randomEnabled && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="位置抖动">
            <NumberField value={randomOffsetMm} min={0} max={10} step={0.5} unit="±mm" onChange={setRandomOffsetMm} />
          </Field>
          <Field label="角度抖动">
            <NumberField value={randomRotationDeg} min={0} max={15} step={0.5} unit="±°" onChange={setRandomRotationDeg} />
          </Field>
        </div>
      )}
      <Button
        variant="primary"
        disabled={disabled}
        onClick={() => {
          if (!effectiveStamp) return
          batchStamp({
            stampId: effectiveStamp.stampId,
            rangeText,
            anchor,
            marginXPt: mmToPt(marginXMm),
            marginYPt: mmToPt(marginYMm),
            randomEnabled,
            randomOffsetPt: mmToPt(randomOffsetMm),
            randomRotationDeg
          })
        }}
      >
        <Stamp size={16} />
        盖到所选范围
      </Button>
    </div>
  )
}
