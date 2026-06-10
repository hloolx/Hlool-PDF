import { CircleAlert, CircleCheck, Download, Eye, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { localizeError } from '../../lib/api'
import type { Job } from '../../lib/types'
import { useEditorStore } from '../../state/store'
import { ConfirmButton, IconButton } from '../../ui/Button'
import { Dialog, DrawerContent } from '../../ui/Dialog'
import { deleteJobAction, refreshWorkspace } from '../workspace/actions'
import { useJobsUi } from './jobsUi'

function formatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** 任务历史抽屉：随时回看与重新下载之前的产物。 */
export function HistoryDrawer() {
  const open = useJobsUi((state) => state.historyOpen)
  const setOpen = useJobsUi((state) => state.setHistoryOpen)
  const setPreviewJob = useJobsUi((state) => state.setPreviewJob)
  const jobs = useEditorStore((state) => state.jobs)
  const files = useEditorStore((state) => state.files)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DrawerContent
        title="任务历史"
        actions={
          <IconButton size="sm" title="刷新" onClick={() => void refreshWorkspace()}>
            <RefreshCw size={16} />
          </IconButton>
        }
      >
        {jobs.length === 0 ? (
          <p className="py-10 text-center text-sm text-ink-muted">还没有生成记录。</p>
        ) : (
          <div className="grid gap-2">
            {jobs.map((job) => (
              <HistoryRow
                key={job.jobId}
                job={job}
                fileName={files.find((f) => f.fileId === job.fileId)?.name}
                onPreview={() => setPreviewJob(job)}
              />
            ))}
          </div>
        )}
      </DrawerContent>
    </Dialog>
  )
}

function HistoryRow({ job, fileName, onPreview }: { job: Job; fileName?: string; onPreview: () => void }) {
  const displayName = job.outputName || fileName || job.jobId
  return (
    <div className="rounded-xl border border-line p-3">
      <div className="flex items-center gap-2">
        {job.status === 'done' ? (
          <CircleCheck size={16} className="shrink-0 text-ok" />
        ) : job.status === 'failed' ? (
          <CircleAlert size={16} className="shrink-0 text-accent" />
        ) : (
          <Loader2 size={16} className="shrink-0 animate-spin text-accent" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium" title={displayName}>
            {displayName}
          </p>
          <p className="text-xs text-ink-muted">{formatTime(job.updatedAt || job.createdAt)}</p>
        </div>
        <div className="flex items-center gap-0.5">
          {job.status === 'done' && job.downloadUrl && (
            <>
              <IconButton size="sm" title="预览" onClick={onPreview}>
                <Eye size={16} />
              </IconButton>
              <IconButton size="sm" title="下载" onClick={() => window.open(job.downloadUrl, '_self')}>
                <Download size={16} />
              </IconButton>
            </>
          )}
          <ConfirmButton size="sm" title="删除记录" confirmLabel="再点一次删除" onConfirm={() => void deleteJobAction(job)}>
            <Trash2 size={16} />
          </ConfirmButton>
        </div>
      </div>
      {job.status === 'failed' && job.error && (
        <p className="mt-1.5 break-words pl-6 text-xs text-ink-muted">{localizeError(job.error)}</p>
      )}
    </div>
  )
}
