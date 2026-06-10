import { FileText, Stamp, Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { PDFFile } from '../../lib/types'
import { activeConfig, useEditorStore } from '../../state/store'
import { ConfirmButton } from '../../ui/Button'
import { Field, TextInput } from '../../ui/Field'
import { Section } from '../../ui/Section'
import { Switch } from '../../ui/Switch'
import { BatchPanel } from './BatchPanel'
import { RangeInput } from './RangeInput'

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/** 未选中任何对象时的检查器：文档信息、本次配置、批量盖章与输出设置。 */
export function DocumentPanel({ file }: { file: PDFFile }) {
  const summary = useEditorStore(
    useShallow((state) => {
      const config = activeConfig(state)
      return {
        placementCount: config.placements.length,
        pageCoverage: new Set(config.placements.map((p) => p.pageNumber)).size,
        seamEnabled: config.seamEnabled
      }
    })
  )
  const setSeamEnabled = useEditorStore((state) => state.setSeamEnabled)
  const clearPlacements = useEditorStore((state) => state.clearPlacements)
  const select = useEditorStore((state) => state.select)
  const outputNameTemplate = useEditorStore((state) => state.outputNameTemplate)
  const setOutputNameTemplate = useEditorStore((state) => state.setOutputNameTemplate)
  const outputPassword = useEditorStore((state) => state.outputPassword)
  const setOutputPassword = useEditorStore((state) => state.setOutputPassword)
  const stampsReady = useEditorStore((state) => state.stamps.length > 0)

  return (
    <div>
      <div className="flex items-center gap-2.5 border-b border-line/70 py-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-sunken text-ink-muted">
          <FileText size={20} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium" title={file.name}>
            {file.name}
          </p>
          <p className="tnum text-xs text-ink-muted">
            {file.pageCount} 页 · {formatBytes(file.size)}
          </p>
        </div>
      </div>

      <Section title="本次配置">
        <div className="flex items-center justify-between gap-2 text-[13px]">
          <span className="flex items-center gap-1.5">
            <Stamp size={16} className="text-ink-muted" />
            普通章 <strong className="tnum">{summary.placementCount}</strong> 个 · 覆盖{' '}
            <strong className="tnum">{summary.pageCoverage}</strong> 页
          </span>
          {summary.placementCount > 0 && (
            <ConfirmButton size="sm" confirmLabel="再点一次清空" title="清空全部印章" onConfirm={clearPlacements}>
              <Trash2 size={16} />
            </ConfirmButton>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 rounded-lg border border-line px-2.5 py-2 text-[13px]">
          <button
            type="button"
            className="flex-1 text-left transition-colors hover:text-accent disabled:pointer-events-none"
            disabled={!summary.seamEnabled}
            onClick={() => select({ kind: 'seam' })}
            title={summary.seamEnabled ? '点击编辑骑缝章参数' : undefined}
          >
            骑缝章
            <span className="ml-1.5 text-xs text-ink-muted">
              {summary.seamEnabled ? '已启用 · 点击编辑' : '印章分片盖在页面边缘'}
            </span>
          </button>
          <Switch
            checked={summary.seamEnabled}
            disabled={!stampsReady}
            onChange={(checked) => setSeamEnabled(checked)}
          />
        </div>
        {!stampsReady && <p className="text-xs text-ink-muted">导入印章图片后可启用骑缝章。</p>}
      </Section>

      <Section title="页面范围">
        <RangeInput />
      </Section>

      <Section title="批量盖章" defaultOpen={false}>
        <BatchPanel />
      </Section>

      <Section title="输出设置" defaultOpen={false}>
        <Field label="输出文件名" hint="{原名} 代表原文件名，生成时自动替换。">
          <TextInput
            value={outputNameTemplate}
            placeholder="{原名}-已盖章"
            onChange={(event) => setOutputNameTemplate(event.currentTarget.value)}
          />
        </Field>
        <Field label="打开密码（可选）" hint={outputPassword ? '已启用 AES-256 加密输出。' : '留空则输出不加密。'}>
          <TextInput
            type="password"
            value={outputPassword}
            autoComplete="new-password"
            onChange={(event) => setOutputPassword(event.currentTarget.value)}
          />
        </Field>
      </Section>
    </div>
  )
}
