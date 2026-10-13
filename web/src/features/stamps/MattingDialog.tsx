import { useEffect, useRef, useState } from 'react'
import { Check, Eraser, Loader2 } from 'lucide-react'
import { Button } from '../../ui/Button'
import { Dialog, DialogContent } from '../../ui/Dialog'
import { removeWhiteBackground } from './matting'
import { toast } from '../../state/toasts'

interface MattingDialogProps {
  open: boolean
  onClose: () => void
  originalFile: File
  originalUrl: string
  onAccept: (blob: Blob, saveAsNew: boolean) => Promise<boolean>
}

export function MattingDialog({ open, onClose, originalFile, originalUrl, onAccept }: MattingDialogProps) {
  const [threshold, setThreshold] = useState(247)
  const [status, setStatus] = useState<'idle' | 'processing' | 'done' | 'saving'>('idle')
  const [result, setResult] = useState<{ blob: Blob; url: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const operation = useRef(0)
  const phase = useRef<'idle' | 'processing' | 'saving'>('idle')
  const locked = status === 'processing' || status === 'saving'

  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url) }, [result])
  useEffect(() => () => { operation.current += 1 }, [])

  function resetPreview() {
    operation.current += 1
    phase.current = 'idle'
    setResult(null)
    setError(null)
    setStatus('idle')
  }

  function handleClose() {
    if (phase.current === 'saving') return
    resetPreview()
    onClose()
  }

  async function startProcess() {
    if (phase.current !== 'idle') return
    phase.current = 'processing'
    const id = ++operation.current
    setStatus('processing')
    setError(null)
    try {
      const blob = await removeWhiteBackground(originalFile, threshold)
      if (id !== operation.current) return
      phase.current = 'idle'
      setResult({ blob, url: URL.createObjectURL(blob) })
      setStatus('done')
    } catch (err) {
      if (id !== operation.current) return
      phase.current = 'idle'
      setStatus('idle')
      setError(err instanceof Error ? err.message : '处理失败，请重试。')
    }
  }

  async function handleAccept(saveAsNew: boolean) {
    if (!result || phase.current !== 'idle') return
    phase.current = 'saving'
    const id = ++operation.current
    setStatus('saving')
    setError(null)
    try {
      const saved = await onAccept(result.blob, saveAsNew)
      if (id !== operation.current) return
      if (!saved) throw new Error('无法保存印章，请检查浏览器可用存储空间后重试。')
      toast(saveAsNew ? '已保存为新印章' : '已替换原印章', { kind: 'success' })
      resetPreview()
      onClose()
    } catch (err) {
      if (id !== operation.current) return
      phase.current = 'idle'
      setStatus('done')
      setError(err instanceof Error ? err.message : '保存失败，请重试。')
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && handleClose()}>
      <DialogContent
        title="本地白底透明化"
        aria-describedby="white-background-description"
        aria-busy={locked}
        className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto"
      >
        <div className="grid gap-4">
          <p id="white-background-description" className="text-sm leading-relaxed text-ink-muted">
            在当前浏览器中去除白色或浅灰背景，图片不上传。适合白底印章；彩色背景请先在其他图像工具中处理。
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <span className="text-xs text-ink-muted">原图</span>
              <div className="checker flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-line">
                <img src={originalUrl} alt="印章原图" className="max-h-full max-w-full" />
              </div>
            </div>
            <div className="grid gap-2">
              <span className="text-xs text-ink-muted">透明背景预览</span>
              <div className="checker flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-line">
                {status === 'processing' ? (
                  <span role="status" className="flex items-center gap-2 text-xs text-ink-muted"><Loader2 size={18} className="animate-spin" />正在处理…</span>
                ) : result ? (
                  <img src={result.url} alt="去白底后的印章" className="max-h-full max-w-full" />
                ) : (
                  <span className="px-3 text-center text-xs text-ink-muted">点击「预览效果」查看结果</span>
                )}
              </div>
            </div>
          </div>
          <div className="grid gap-2">
            <label htmlFor="white-threshold" className="flex items-center justify-between text-xs text-ink-muted">
              <span>去白范围</span>
              <span className="tnum">{255 - threshold + 1} / 56</span>
            </label>
            <input
              id="white-threshold"
              type="range"
              min={1}
              max={56}
              value={255 - threshold + 1}
              disabled={locked}
              aria-describedby="white-threshold-help"
              className="w-full accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/60"
              onChange={(event) => { setThreshold(256 - Number(event.currentTarget.value)); resetPreview() }}
            />
            <p id="white-threshold-help" className="text-xs leading-relaxed text-ink-muted">向右会去除更多浅色区域，也可能影响印章细节，请先检查预览。</p>
          </div>
          {error && <p role="alert" className="break-words text-sm text-accent">{error}</p>}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" disabled={status === 'saving'} onClick={handleClose}>保留原图</Button>
            {!result && (
              <Button disabled={locked} onClick={() => void startProcess()}>
                {status === 'processing' ? <Loader2 size={16} className="animate-spin" /> : <Eraser size={16} />}
                {status === 'processing' ? '正在处理…' : '预览效果'}
              </Button>
            )}
            {result && (
              <>
                <Button disabled={locked} onClick={() => void handleAccept(true)}>另存为新印章</Button>
                <Button disabled={locked} onClick={() => void handleAccept(false)}>
                  {status === 'saving' ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                  {status === 'saving' ? '正在保存…' : '替换原印章'}
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
