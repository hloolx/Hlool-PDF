import { ArrowLeft, PanelRightClose, Sparkles } from 'lucide-react'
import { cx } from '../../lib/cx'
import { DEFAULT_SCAN, type ScanConfig } from '../../lib/types'
import { activeConfig, rightDocked, useEditorStore } from '../../state/store'
import { Button } from '../../ui/Button'
import { Field, NumberField } from '../../ui/Field'
import { Section } from '../../ui/Section'
import { Segmented } from '../../ui/Segmented'
import { Slider } from '../../ui/Slider'
import { Switch } from '../../ui/Switch'
import { SCAN_PRESETS } from '../scan/presets'

export function ScanInspector() {
  const config = useEditorStore((state) => activeConfig(state).scanConfig ?? DEFAULT_SCAN)
  const setScanConfig = useEditorStore((state) => state.setScanConfig)
  const enabled = useEditorStore((state) => Boolean(activeConfig(state).scanEnabled))
  const docked = useEditorStore(rightDocked)

  function returnToDocument() {
    const state = useEditorStore.getState()
    state.select(null)
    state.arm(null)
    state.closeMobilePanel()
  }

  function applyPreset(presetKey: string) {
    const preset = SCAN_PRESETS[presetKey]
    if (preset) {
      setScanConfig({ ...preset.config, preset: presetKey })
    }
  }

  return (
    <div>
      <div className="sticky top-0 z-10 border-b border-line bg-panel py-2">
        <Button size="sm" className="w-full justify-start" onClick={returnToDocument}>
          <ArrowLeft size={16} />返回文档
        </Button>
        {!docked && (
          <Button size="sm" className="mt-1 w-full justify-start" onClick={() => useEditorStore.getState().closeMobilePanel()}>
            <PanelRightClose size={16} />收起参数，查看预览
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2.5 py-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Sparkles size={20} />
        </span>
        <div className="min-w-0">
          <p className="text-[13px] font-medium">扫描效果</p>
          <p className="text-xs text-ink-muted">让电子 PDF 看起来像打印扫描的</p>
        </div>
      </div>

      <label className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-line px-2.5 py-2 text-[13px]">
        <span>生成时应用扫描效果</span>
        <Switch checked={enabled} onChange={(checked) => useEditorStore.getState().setScanEnabled(checked)} />
      </label>
      <p className="mt-2 text-xs leading-relaxed text-ink-muted">
        预览显示在文档工作区，包含普通章与骑缝章。生成时每页会叠加随机偏转；退出预览会保留扫描设置。
      </p>

      <Section title="预设" defaultOpen>
        <div className="grid grid-cols-2 gap-2">
          {Object.entries(SCAN_PRESETS).map(([key, { label }]) => (
            <Button
              key={key}
              size="sm"
              variant={config.preset === key ? 'primary' : 'ghost'}
              className={cx('w-full', config.preset === key && 'pointer-events-none')}
              onClick={() => applyPreset(key)}
            >
              {label}
            </Button>
          ))}
        </div>
      </Section>

      <Section title="旋转" defaultOpen>
        <Field label="角度">
          <Slider
            value={config.rotate}
            min={0}
            max={3}
            step={0.1}
            onChange={(rotate) => setScanConfig({ rotate })}
          />
          <div className="mt-1 text-xs text-ink-muted">{config.rotate.toFixed(1)}°</div>
        </Field>
        <Field label="随机变化">
          <Slider
            value={config.rotateVariance}
            min={0}
            max={2}
            step={0.1}
            onChange={(rotateVariance) => setScanConfig({ rotateVariance })}
          />
          <div className="mt-1 text-xs text-ink-muted">±{config.rotateVariance.toFixed(1)}°</div>
        </Field>
      </Section>

      <Section title="效果" defaultOpen>
        <Field label="模糊">
          <Slider
            value={config.blur}
            min={0}
            max={1}
            step={0.05}
            onChange={(blur) => setScanConfig({ blur })}
          />
          <div className="mt-1 text-xs text-ink-muted">{config.blur.toFixed(2)}</div>
        </Field>

        <Field label="噪点">
          <Slider
            value={config.noise}
            min={0}
            max={0.5}
            step={0.01}
            onChange={(noise) => setScanConfig({ noise })}
          />
          <div className="mt-1 text-xs text-ink-muted">{config.noise.toFixed(2)}</div>
        </Field>

        <Field label="亮度">
          <Slider
            value={config.brightness}
            min={0.8}
            max={1.2}
            step={0.01}
            onChange={(brightness) => setScanConfig({ brightness })}
          />
          <div className="mt-1 text-xs text-ink-muted">{config.brightness.toFixed(2)}</div>
        </Field>

        <Field label="对比度">
          <Slider
            value={config.contrast}
            min={0.8}
            max={1.3}
            step={0.01}
            onChange={(contrast) => setScanConfig({ contrast })}
          />
          <div className="mt-1 text-xs text-ink-muted">{config.contrast.toFixed(2)}</div>
        </Field>

        <Field label="泛黄">
          <Slider
            value={config.yellowish}
            min={0}
            max={0.5}
            step={0.01}
            onChange={(yellowish) => setScanConfig({ yellowish })}
          />
          <div className="mt-1 text-xs text-ink-muted">{config.yellowish.toFixed(2)}</div>
        </Field>
      </Section>

      <Section title="其他" defaultOpen={false}>
        <Field label="色彩模式">
          <Segmented
            value={config.colorspace}
            options={[
              { value: 'sRGB', label: '彩色' },
              { value: 'gray', label: '黑白' }
            ]}
            onChange={(colorspace) => setScanConfig({ colorspace: colorspace as 'sRGB' | 'gray' })}
          />
        </Field>

        <div className="flex items-center justify-between rounded-lg border border-line px-2.5 py-2">
          <span className="text-[13px]">边框</span>
          <Switch checked={config.border} onChange={(border) => setScanConfig({ border })} />
        </div>

        <Field label="清晰度">
          <NumberField
            value={config.scale}
            min={0.5}
            max={3}
            step={0.1}
            onChange={(scale) => setScanConfig({ scale })}
          />
          <div className="mt-1 text-xs text-ink-muted">渲染倍率，只影响清晰度，不改变纸张大小</div>
        </Field>

        <Field label="输出格式">
          <Segmented
            value={config.outputFormat}
            options={[
              { value: 'image/jpeg', label: 'JPEG（推荐）' },
              { value: 'image/png', label: 'PNG' }
            ]}
            onChange={(outputFormat) => setScanConfig({ outputFormat: outputFormat as ScanConfig['outputFormat'] })}
          />
        </Field>
      </Section>
    </div>
  )
}
