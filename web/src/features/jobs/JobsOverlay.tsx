import { useEffect, useMemo, useRef } from 'react'
import { CircleAlert, Download, Eye, History, Loader2, X } from 'lucide-react'
import { getJSON } from '../../lib/api'
import type { Job } from '../../lib/types'
import { localizeError } from '../../lib/api'
import { useEditorStore } from '../../state/store'
import { Button, IconButton } from '../../ui/Button'
import { usePdfDocument } from '../viewer/usePdfDocument'
import { useJobsUi } from './jobsUi'
import { retryJob } from './actions'

/** 右下角任务浮层：进行中显示进度，完成后变结果卡。 */
export function JobsOverlay() {
  const jobs = useEditorStore((state) => state.jobs)
  const files = useEditorStore((state) => state.files)
  const upsertJob = useEditorStore((state) => state.upsertJob)
  const sessionJobIds = useJobsUi((state) => state.sessionJobIds)
  const dismissed = useJobsUi((state) => state.dismissed)
  const batch = useJobsUi((state) => state.batch)

  const cards = useMemo(() => {
    return sessionJobIds
      .map((id) => jobs.find((job) => job.jobId === id))
      .filter((job): job is Job => Boolean(job) && !dismissed.includes(job!.jobId))
      .slice(0, 4)
  }, [sessionJobIds, jobs, dismissed])

  const activeIds = useMemo(
    () => cards.filter((job) => job.status === 'queued' || job.status === 'running').map((job) => job.jobId),
    [cards]
  )
  const activeKey = activeIds.join(',')
  const pollRef = useRef(activeIds)
  pollRef.current = activeIds

  useEffect(() => {
    if (activeKey === '') return
    const timer = window.setInterval(async () => {
      const updates = await Promise.allSettled(pollRef.current.map((id) => getJSON<Job>(`/api/jobs/${id}`)))
      for (const result of updates) {
        if (result.status === 'fulfilled') upsertJob(result.value)
      }
    }, 700)
    return () => window.clearInterval(timer)
  }, [activeKey, upsertJob])

  if (cards.length === 0 && !batch) return null

  return (
    <div className="flex w-[330px] flex-col gap-2">
      {batch && (
        <div className="anim-rise flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2.5 text-[13px] shadow-pop">
          <Loader2 size={16} className="animate-spin text-accent" />
          <span className="tnum">
            正在批量提交 {batch.submitted}/{batch.total} 个任务…
          </span>
        </div>
      )}
      {cards.map((job) => (
        <JobCard key={job.jobId} job={job} fileName={files.find((f) => f.fileId === job.fileId)?.name} />
      ))}
    </div>
  )
}

function JobCard({ job, fileName }: { job: Job; fileName?: string }) {
  const dismiss = useJobsUi((state) => state.dismiss)
  const setPreviewJob = useJobsUi((state) => state.setPreviewJob)
  const setHistoryOpen = useJobsUi((state) => state.setHistoryOpen)
  const displayName = job.outputName || fileName || job.jobId

  if (job.status === 'failed') {
    return (
      <div className="anim-rise rounded-xl border border-accent/40 bg-panel p-3 shadow-pop">
        <div className="flex items-start gap-2">
          <CircleAlert size={16} className="mt-0.5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium" title={displayName}>
              {displayName}
            </p>
            <p className="mt-0.5 break-words text-xs text-ink-muted">{localizeError(job.error ?? '生成失败')}</p>
          </div>
          <IconButton size="sm" onClick={() => dismiss(job.jobId)} aria-label="关闭">
            <X size={16} />
          </IconButton>
        </div>
        <div className="mt-2 flex justify-end">
          <Button size="sm" onClick={() => void retryJob(job)}>
            重试
          </Button>
        </div>
      </div>
    )
  }

  if (job.status === 'done' && job.downloadUrl) {
    return (
      <div className="anim-rise flex items-center gap-3 rounded-xl border border-line bg-panel p-3 shadow-pop">
        <ResultThumb job={job} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium" title={displayName}>
            {displayName}
          </p>
          <p className="mt-0.5 text-xs text-ok">生成完成</p>
          <div className="mt-1.5 flex items-center gap-1">
            <Button size="sm" variant="primary" className="px-2" onClick={() => window.open(job.downloadUrl, '_self')}>
              <Download size={15} />
              下载
            </Button>
            <Button size="sm" className="px-2" onClick={() => setPreviewJob(job)}>
              <Eye size={15} />
              预览
            </Button>
            <IconButton size="sm" title="任务历史" onClick={() => setHistoryOpen(true)}>
              <History size={16} />
            </IconButton>
          </div>
        </div>
        <IconButton size="sm" className="self-start" onClick={() => dismiss(job.jobId)} aria-label="关闭">
          <X size={16} />
        </IconButton>
      </div>
    )
  }

  return (
    <div className="anim-rise rounded-xl border border-line bg-panel p-3 shadow-pop">
      <div className="flex items-center gap-2">
        <Loader2 size={16} className="animate-spin text-accent" />
        <p className="min-w-0 flex-1 truncate text-[13px]" title={displayName}>
          正在生成 {displayName}
        </p>
        <span className="tnum text-xs text-ink-muted">{job.progress}%</span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${job.progress}%` }} />
      </div>
    </div>
  )
}

/** 结果 PDF 首页缩略图（走 inline 端点，由 PDF.js 渲染）。 */
function ResultThumb({ job }: { job: Job }) {
  const { doc } = usePdfDocument(job.downloadUrl ? `${job.downloadUrl}?inline=1` : null)
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !doc) return
    let cancelled = false
    doc
      .getPage(1)
      .then((page) => {
        if (cancelled || !ref.current) return
        const base = page.getViewport({ scale: 1 })
        const scale = (52 / base.width) * Math.min(window.devicePixelRatio || 1, 2)
        const viewport = page.getViewport({ scale })
        const target = ref.current
        const context = target.getContext('2d')
        if (!context) return
        target.width = Math.round(viewport.width)
        target.height = Math.round(viewport.height)
        page.render({ canvas: target, canvasContext: context, viewport }).promise.catch(() => {})
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [doc])

  return (
    <span className="block w-[52px] shrink-0 overflow-hidden rounded border border-line bg-white">
      <canvas ref={ref} className="block h-auto w-full" />
    </span>
  )
}
