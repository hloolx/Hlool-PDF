import { useRef, useState } from 'react'
import { Database, Download, Loader2, Upload } from 'lucide-react'
import { OfflineStatus } from '../../app/OfflineStatus'
import { downloadBlob } from '../../lib/download'
import { toast } from '../../state/toasts'
import { useEditorStore } from '../../state/store'
import { beginOperation } from '../../state/operations'
import { Button } from '../../ui/Button'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '../../ui/Menu'
import { exportLibraryBackup, importLibraryBackup } from '../library/backup'

export function LocalDataMenu() {
  const inputRef = useRef<HTMLInputElement>(null)
  const operationRef = useRef(false)
  const workspaceBusy = useEditorStore((state) => state.busy)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [result, setResult] = useState<{ text: string; error: boolean } | null>(null)

  async function runOperation(kind: 'export' | 'import', operation: () => Promise<string>) {
    if (operationRef.current) return
    const operationLock = beginOperation(kind === 'export' ? '正在导出资料备份…' : '正在导入资料备份…')
    if (!operationLock) {
      setResult({ text: '当前操作尚未完成，请稍候再导入或导出备份。', error: true })
      return
    }
    operationRef.current = true
    setBusy(kind)
    setResult(null)
    try {
      const text = await operation()
      setResult({ text, error: false })
      toast(text, { kind: 'success' })
    } catch (err) {
      const detail = err instanceof Error ? err.message : '请重试。'
      const text = `${kind === 'export' ? '导出' : '导入'}备份失败：${detail}`
      setResult({ text, error: true })
      toast(text, { kind: 'error' })
    } finally {
      operationRef.current = false
      setBusy(null)
      operationLock.end()
    }
  }

  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger asChild>
          <Button variant="ghost" className="shrink-0 px-2" title="本地资料与备份" aria-label="本地资料">
            {busy ? <Loader2 size={17} className="animate-spin" /> : <Database size={17} />}
            <span className="hidden sm:inline">本地资料</span>
          </Button>
        </MenuTrigger>
        <MenuContent aria-busy={busy !== null} className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto">
          <MenuLabel className="font-medium text-ink">本地资料</MenuLabel>
          <div className="space-y-2 px-2.5 pb-2 text-xs leading-relaxed text-ink-muted">
            <p>印章和设置保存在当前浏览器。更换浏览器、使用隐私窗口或清理站点数据后，资料可能不可用或丢失，请定期导出备份。</p>
            <p>备份包含印章和偏好设置，不包含 PDF 文件或密码。导入会合并印章并恢复备份中的偏好，不清空现有印章。</p>
            <p>PDF 和页面编辑只保留在当前窗口。刷新或关闭前，请先生成并下载需要保留的文件。</p>
            <OfflineStatus />
          </div>
          <MenuSeparator />
          <MenuItem
            disabled={busy !== null || Boolean(workspaceBusy)}
            onSelect={(event) => {
              event.preventDefault()
              void runOperation('export', async () => {
                const blob = await exportLibraryBackup()
                const date = new Date().toLocaleDateString('sv-SE')
                downloadBlob(blob, `hlool-pdf-本地资料-${date}.zip`)
                return '备份已生成，请妥善保存下载的 ZIP 文件。'
              })
            }}
          >
            {busy === 'export' ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            {busy === 'export' ? '正在导出备份…' : '导出备份…'}
          </MenuItem>
          <MenuItem
            disabled={busy !== null || Boolean(workspaceBusy)}
            onSelect={(event) => {
              event.preventDefault()
              inputRef.current?.click()
            }}
          >
            {busy === 'import' ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
            {busy === 'import' ? '正在导入备份…' : '导入备份…'}
          </MenuItem>
          {result && (
            <p role={result.error ? 'alert' : 'status'} className={`break-words px-2.5 py-2 text-xs leading-relaxed ${result.error ? 'text-accent' : 'text-ink-muted'}`}>
              {result.text}
            </p>
          )}
        </MenuContent>
      </Menu>
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        aria-label="选择本地资料备份"
        className="hidden"
        disabled={busy !== null || Boolean(workspaceBusy)}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (!file) return
          setOpen(true)
          void runOperation('import', async () => {
            const { imported } = await importLibraryBackup(file)
            return `备份导入完成：已导入 ${imported} 个印章，偏好设置已恢复。`
          })
        }}
      />
    </>
  )
}
