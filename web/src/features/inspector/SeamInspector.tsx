import {
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  ChevronDown,
  Dices,
  Trash2
} from 'lucide-react'
import { parsePageExpression, summarizePages } from '../../lib/pages'
import type { PDFFile, SeamSide } from '../../lib/types'
import { mmToPt, ptToMm } from '../../lib/units'
import { activeConfig, useEditorStore } from '../../state/store'
import { toast } from '../../state/toasts'
import { Button, IconButton } from '../../ui/Button'
import { Field, NumberField, TextInput } from '../../ui/Field'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../ui/Menu'
import { Section } from '../../ui/Section'
import { Segmented } from '../../ui/Segmented'
import { Slider } from '../../ui/Slider'
import { Switch } from '../../ui/Switch'
import { Tip } from '../../ui/Tooltip'

const SIDES: Array<{ value: SeamSide; label: string; icon: React.ReactNode }> = [
  { value: 'left', label: '左', icon: <ArrowLeftToLine size={16} /> },
  { value: 'right', label: '右', icon: <ArrowRightToLine size={16} /> },
  { value: 'top', label: '上', icon: <ArrowUpToLine size={16} /> },
  { value: 'bottom', label: '下', icon: <ArrowDownToLine size={16} /> }
]

const SIZE_PRESETS = [40, 42, 45]

function newSeed() {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return buf[0] || 1
}

/** 骑缝章检查器：参数全部所见即所得（画布上即真实切片）。 */
export function SeamInspector({ file }: { file: PDFFile }) {
  const seam = useEditorStore((state) => activeConfig(state).seam)
  const setSeam = useEditorStore((state) => state.setSeam)
  const setSeamEnabled = useEditorStore((state) => state.setSeamEnabled)
  const stamps = useEditorStore((state) => state.stamps)
  const stampMeta = useEditorStore((state) => state.stampMeta)

  const stamp = stamps.find((s) => s.stampId === seam.stampId) ?? null
  const expr = parsePageExpression(seam.pages, file.pageCount)
  const labelOf = (id: string) => {
    const found = stamps.find((s) => s.stampId === id)
    return found ? stampMeta[id]?.alias || found.name : ''
  }

  return (
    <div>
      <div className="border-b border-line/70 py-3">
        <p className="text-[13px] font-medium">骑缝章</p>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
          印章按页数切片分布到每页边缘，画布上显示的就是真实切片。
        </p>
      </div>

      <Section title="印章与边缘">
        <Field label="使用印章">
          <Menu>
            <MenuTrigger asChild>
              <Button className="w-full justify-between" disabled={stamps.length === 0}>
                <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  {stamp && <img src={stamp.url} alt="" className="size-5 shrink-0 object-contain" />}
                  <span className="min-w-0 flex-1 truncate">{stamp ? labelOf(stamp.stampId) : '选择印章'}</span>
                </span>
                <ChevronDown size={16} className="shrink-0 text-ink-muted" />
              </Button>
            </MenuTrigger>
            <MenuContent align="start" className="max-h-72 max-w-[252px] overflow-y-auto">
              {stamps.map((item) => (
                <MenuItem key={item.stampId} onSelect={() => setSeam({ stampId: item.stampId })}>
                  <img src={item.url} alt="" className="size-5 shrink-0 object-contain" />
                  <span className="min-w-0 flex-1 truncate">{labelOf(item.stampId)}</span>
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        </Field>
        <Field label="所在边">
          <Segmented
            value={seam.side}
            onChange={(side) => setSeam({ side })}
            options={SIDES.map((side) => ({
              value: side.value,
              title: side.label,
              label: (
                <span className="flex min-w-0 items-center justify-center" aria-hidden="true">
                  {side.icon}
                </span>
              )
            }))}
          />
        </Field>
        <Field
          label="页面范围"
          hint={
            expr.invalidParts.length > 0
              ? `无效：${expr.invalidParts.join('、')}`
              : expr.pages.length < 2
                ? '骑缝章至少需要 2 页'
                : summarizePages(expr.pages, file.pageCount)
          }
        >
          <TextInput
            value={seam.pages}
            placeholder="全部 或 1-10"
            onChange={(event) => setSeam({ pages: event.currentTarget.value })}
          />
        </Field>
      </Section>

      <Section title="尺寸与位置">
        {/* 286px 侧栏放不下双列（尺寸输入 + 预设按钮会被挤压），改为单列纵排 */}
        <Field label="印章尺寸">
          <span className="flex gap-1">
            <NumberField
              className="min-w-0 flex-1"
              value={ptToMm(seam.sizePt)}
              min={10}
              max={176}
              unit="mm"
              onChange={(mm) => setSeam({ sizePt: mmToPt(mm) })}
            />
            <Menu>
              <MenuTrigger asChild>
                <IconButton title="常用尺寸">
                  <ChevronDown size={16} />
                </IconButton>
              </MenuTrigger>
              <MenuContent align="end" className="min-w-24">
                {SIZE_PRESETS.map((mm) => (
                  <MenuItem key={mm} className="tnum" onSelect={() => setSeam({ sizePt: mmToPt(mm) })}>
                    {mm} mm
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          </span>
        </Field>
        <Field label="边缘留白">
          <NumberField
            value={ptToMm(seam.marginPt)}
            min={0}
            max={42}
            unit="mm"
            onChange={(mm) => setSeam({ marginPt: mmToPt(mm) })}
          />
        </Field>
        <Field
          label={
            <span className="flex w-full items-center justify-between gap-2">
              <span className="min-w-0">沿边位置（可在页面上直接拖动）</span>
              <span className="tnum shrink-0">{Math.round(seam.positionPercent)}%</span>
            </span>
          }
        >
          <Slider
            value={seam.positionPercent}
            min={0}
            max={100}
            onChange={(positionPercent) => setSeam({ positionPercent })}
          />
        </Field>
      </Section>

      <Section title="切片方式">
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0 flex-1 text-[13px]">
            随机分割
            <span className="block text-xs leading-relaxed text-ink-muted">每页宽窄不一，更像手工盖的</span>
          </span>
          <Switch
            className="mt-0.5"
            checked={seam.randomSeed !== 0}
            onChange={(checked) => setSeam({ randomSeed: checked ? newSeed() : 0 })}
          />
        </div>
        {seam.randomSeed !== 0 && (
          <Button
            onClick={() => {
              setSeam({ randomSeed: newSeed() })
              toast('已换一组随机切缝', { ttlMs: 1600 })
            }}
          >
            <Dices size={16} />
            换一组切法
          </Button>
        )}
        <Field
          label="最大分割数"
          hint={`超过该页数后从头循环切片；当前范围 ${expr.pages.length} 页，将切成 ${Math.min(
            Math.max(1, seam.maxSlices),
            Math.max(1, expr.pages.length)
          )} 片`}
        >
          <NumberField value={seam.maxSlices} min={2} max={100} onChange={(maxSlices) => setSeam({ maxSlices })} />
        </Field>
        <Field
          label={
            <span className="flex w-full items-center justify-between gap-2">
              <span className="min-w-0">不透明度</span>
              <span className="tnum shrink-0">{Math.round(seam.opacity * 100)}%</span>
            </span>
          }
        >
          <Slider
            value={Math.round(seam.opacity * 100)}
            min={10}
            max={100}
            onChange={(value) => setSeam({ opacity: value / 100 })}
          />
        </Field>
      </Section>

      <div className="py-3">
        <Tip label="从本次任务移除骑缝章（参数会保留）">
          <Button variant="danger" className="w-full" onClick={() => setSeamEnabled(false)}>
            <Trash2 size={16} />
            移除骑缝章
          </Button>
        </Tip>
      </div>
    </div>
  )
}
