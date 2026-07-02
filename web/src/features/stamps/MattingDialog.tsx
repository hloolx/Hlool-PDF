import { useState } from 'react'
import { Sparkles, X, Check } from 'lucide-react'
import { Button } from '../../ui/Button'
import { Dialog, DialogContent } from '../../ui/Dialog'
import { mattingPreview, base64ToBlob } from './matting'
import { toast } from '../../state/toasts'

interface MattingDialogProps {
  open: boolean
  onClose: () => void
  originalFile: File
  originalUrl: string
  onAccept: (blob: Blob, saveAsNew: boolean) => void
}

export function MattingDialog({ open, onClose, originalFile, originalUrl, onAccept }: MattingDialogProps) {
  const [status, setStatus] = useState<'idle' | 'processing' | 'done' | 'error'>('idle')
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function startProcess() {
    setStatus('processing')
    setError(null)
    try {
      const base64 = await mattingPreview(originalFile)
      const blob = base64ToBlob(base64)
      const url = URL.createObjectURL(blob)
      setResultUrl(url)
      setStatus('done')
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : '处理失败')
    }
  }

  function handleClose() {
    if (resultUrl) URL.revokeObjectURL(resultUrl)
    setStatus('idle')
    setResultUrl(null)
    setError(null)
    onClose()
  }

  async function handleAccept(saveAsNew: boolean) {
    if (!resultUrl) return
    try {
      const response = await fetch(resultUrl)
      const blob = await response.blob()
      onAccept(blob, saveAsNew)
      toast(saveAsNew ? '已保存为新印章' : '已替换原印章', { kind: 'success' })
      handleClose()
    } catch {
      toast('保存失败', { kind: 'error' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="max-w-3xl" title="AI 背景移除">

        <div className="grid gap-4">
          {status === 'idle' && (
            <div className="flex flex-col items-center gap-4 py-8">
              <Sparkles size={48} className="text-accent" />
              <p className="text-center text-sm text-ink-muted">
                使用 AI 智能移除印章图片的背景，生成透明 PNG
              </p>
              <Button onClick={startProcess}>
                <Sparkles size={16} />
                开始处理
              </Button>
            </div>
          )}

          {status === 'processing' && (
            <div className="flex flex-col items-center gap-4 py-12">
              <div className="size-12 animate-spin rounded-full border-4 border-line border-t-accent" />
              <p className="text-sm text-ink-muted">正在处理中...</p>
            </div>
          )}

          {status === 'error' && (
            <div className="flex flex-col items-center gap-4 py-8">
              <X size={48} className="text-danger" />
              <p className="text-center text-sm text-danger">{error}</p>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={handleClose}>
                  关闭
                </Button>
                <Button onClick={startProcess}>重试</Button>
              </div>
            </div>
          )}

          {status === 'done' && resultUrl && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-ink-muted">原图</span>
                  <div className="checker flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-line">
                    <img src={originalUrl} alt="原图" className="max-h-full max-w-full" />
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-accent">透明背景</span>
                  <div className="checker flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-accent">
                    <img src={resultUrl} alt="结果" className="max-h-full max-w-full" />
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={handleClose}>
                  保留原图
                </Button>
                <Button onClick={() => handleAccept(true)}>
                  另存为新印章
                </Button>
                <Button onClick={() => handleAccept(false)}>
                  <Check size={16} />
                  替换原印章
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
