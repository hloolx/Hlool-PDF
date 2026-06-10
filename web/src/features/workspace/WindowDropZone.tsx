import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FilePlus, FileStack, Stamp } from 'lucide-react'
import { cx } from '../../lib/cx'
import { activeFile, useEditorStore } from '../../state/store'
import { toast } from '../../state/toasts'
import { importAsNewProject, importIntoCurrent, isImportableImage, uploadStamps } from './actions'

type Zone = 'current' | 'new' | 'stamp'

/**
 * 窗口级拖放：拖入文件后全屏出现三个落点 ——
 * 左 = 并入当前项目（追加页面），右 = 作为新项目打开，底部 = 加入印章架（仅图片）。
 */
export function WindowDropZone() {
  const [active, setActive] = useState(false)
  const [zone, setZone] = useState<Zone | null>(null)
  const [count, setCount] = useState(0)
  const depth = useRef(0)
  const current = useEditorStore(activeFile)

  useEffect(() => {
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false

    const reset = () => {
      depth.current = 0
      setActive(false)
      setZone(null)
      setCount(0)
    }
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth.current++
      setActive(true)
      const items = event.dataTransfer?.items
      if (items && items.length > 0) setCount(items.length)
    }
    const onDragOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault()
    }
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) reset()
    }
    // 各落点的 React onDrop 先于这里执行；窗口级 drop 只负责收尾与兜底（防止浏览器直接打开文件）。
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      reset()
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  if (!active) return null

  return (
    <div
      className="anim-fade fixed inset-0 z-[120] flex flex-col gap-3 bg-canvas/85 p-6 backdrop-blur-sm"
      onDragOver={(event) => {
        event.preventDefault()
        setZone(null)
      }}
    >
      <p className="pointer-events-none text-center text-sm font-medium text-ink">
        {count > 1 ? `导入 ${count} 个文件 · ` : ''}松开放到对应区域
      </p>
      <div className="flex min-h-0 flex-1 gap-3">
        {current && (
          <DropPanel
            active={zone === 'current'}
            icon={<FileStack size={26} />}
            title="并入当前项目"
            desc={
              <>
                页面追加到「<span className="font-medium text-ink">{current.name}</span>」末尾 · 印章配置保留 · 可撤销
              </>
            }
            onHover={() => setZone('current')}
            onDropFiles={(files) => void importIntoCurrent(files)}
          />
        )}
        <DropPanel
          active={zone === 'new'}
          icon={<FilePlus size={26} />}
          title={current ? '作为新项目打开' : '导入为新项目'}
          desc="每个 PDF 单独成项目 · 多张图片自动合成一个文档"
          onHover={() => setZone('new')}
          onDropFiles={(files) => void importAsNewProject(files)}
        />
      </div>
      <DropPanel
        horizontal
        className="h-[148px] flex-none"
        active={zone === 'stamp'}
        icon={<Stamp size={26} />}
        title="加入印章架"
        desc="印章仅支持图片 PNG / JPG / WebP · 白底自动透明化"
        onHover={() => setZone('stamp')}
        onDropFiles={(files) => {
          const images = files.filter(isImportableImage)
          if (images.length < files.length) {
            toast(`印章只支持图片格式，已忽略 ${files.length - images.length} 个其他文件`, { kind: 'error' })
          }
          if (images.length > 0) void uploadStamps(images)
        }}
      />
    </div>
  )
}

function DropPanel({
  active,
  horizontal,
  icon,
  title,
  desc,
  className,
  onHover,
  onDropFiles
}: {
  active: boolean
  horizontal?: boolean
  icon: ReactNode
  title: string
  desc: ReactNode
  className?: string
  onHover: () => void
  onDropFiles: (files: File[]) => void
}) {
  return (
    <div
      className={cx(
        'flex flex-1 select-none items-center justify-center rounded-2xl border-2 border-dashed px-6 transition-all duration-150',
        horizontal ? 'flex-row gap-4' : 'flex-col gap-3',
        active ? 'scale-[1.01] border-accent bg-accent-soft/80 shadow-pop' : 'border-line bg-panel/90',
        className
      )}
      onDragOver={(event) => {
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'copy'
        onHover()
      }}
      onDrop={(event) => {
        event.preventDefault()
        const files = Array.from(event.dataTransfer.files)
        if (files.length > 0) onDropFiles(files)
      }}
    >
      <span
        className={cx(
          'flex size-14 shrink-0 items-center justify-center rounded-2xl transition-all duration-150',
          active ? 'scale-110 bg-accent text-white shadow-pop' : 'bg-sunken text-ink-muted'
        )}
      >
        {icon}
      </span>
      <div className={cx('max-w-[420px]', horizontal ? 'text-left' : 'text-center')}>
        <p className={cx('text-[15px] font-semibold', active && 'text-accent')}>{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">{desc}</p>
      </div>
    </div>
  )
}
