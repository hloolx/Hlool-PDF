import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BookCopy, FileUp, Loader2, Plus, X } from 'lucide-react'
import { errorText, postJSON } from '../../lib/api'
import { cx } from '../../lib/cx'
import type { PDFDocumentProxy } from '../../lib/pdfjs'
import type { PDFFile } from '../../lib/types'
import { switchFile, useEditorStore } from '../../state/store'
import { toast } from '../../state/toasts'
import { Button, IconButton } from '../../ui/Button'
import { Dialog, DialogClose, DialogTitle, FullDialogContent } from '../../ui/Dialog'
import { TextInput } from '../../ui/Field'
import { SectionTitle } from '../../ui/Section'
import { Tip } from '../../ui/Tooltip'
import { importAsNewProject } from '../workspace/actions'
import { MAX_COMPOSE_PAGES, SOURCE_COLORS, useOrganize, type OrgItem } from './organizeUi'
import { useDocs } from './useDocs'
import { useOrgThumb } from './thumbs'

/** 页面整理 / 拼接：把多个 PDF 的页面混排成一个新文件，拖动换位带 FLIP 动效。 */
export function Organizer() {
  const open = useOrganize((state) => state.open)
  const close = useOrganize((state) => state.close)
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      {open && <OrganizerContent />}
    </Dialog>
  )
}

function OrganizerContent() {
  const items = useOrganize((state) => state.items)
  const name = useOrganize((state) => state.name)
  const busy = useOrganize((state) => state.busy)
  const setName = useOrganize((state) => state.setName)
  const files = useEditorStore((state) => state.files)
  const fileRevs = useEditorStore((state) => state.fileRevs)
  const itemFileIds = [...new Set(items.map((item) => item.fileId))]
  const docs = useDocs(itemFileIds, fileRevs)
  const multiSource = itemFileIds.length > 1

  async function generate() {
    if (items.length === 0) return
    const finalName = (name.trim() || '拼接文档').replace(/\.pdf$/i, '') + '.pdf'
    useOrganize.getState().setBusy(true)
    try {
      const file = await postJSON<PDFFile>('/api/files/compose', {
        name: finalName,
        pages: items.map(({ fileId, pageNumber }) => ({ fileId, pageNumber }))
      })
      useEditorStore.getState().upsertFiles([file])
      switchFile(file.fileId)
      useOrganize.getState().close()
      toast(`已生成 ${file.name}（${file.pageCount} 页），已切换为当前文件`, { kind: 'success' })
    } catch (err) {
      toast(errorText(err), { kind: 'error' })
    } finally {
      useOrganize.getState().setBusy(false)
    }
  }

  return (
    <FullDialogContent aria-describedby={undefined}>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
        <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
          <BookCopy size={18} className="text-accent" />
          页面整理 / 拼接
        </DialogTitle>
        <span className="tnum rounded-full bg-sunken px-2.5 py-0.5 text-xs text-ink-muted">{items.length} 页</span>
        <div className="flex-1" />
        <TextInput
          className="w-64"
          value={name}
          placeholder="输出文件名"
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <Button variant="primary" disabled={items.length === 0 || busy} onClick={() => void generate()}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
          生成新 PDF
        </Button>
        <DialogClose asChild>
          <IconButton aria-label="关闭">
            <X size={18} />
          </IconButton>
        </DialogClose>
      </header>
      <div className="flex min-h-0 flex-1">
        <SourceRail files={files} />
        <PageGrid items={items} files={files} docs={docs} multiSource={multiSource} />
      </div>
    </FullDialogContent>
  )
}

function SourceRail({ files }: { files: PDFFile[] }) {
  const items = useOrganize((state) => state.items)
  const addFilePages = useOrganize((state) => state.addFilePages)
  const usedCount = (fileId: string) => items.filter((item) => item.fileId === fileId).length

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line">
      <div className="px-3 pt-3">
        <SectionTitle>来源文件</SectionTitle>
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">点击「加入」把整个文件的页面追加到右侧，再拖动调整顺序。</p>
      </div>
      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto p-3">
        <div className="grid gap-2">
          {files.map((file, index) => (
            <div key={file.fileId} className="rounded-xl border border-line p-2.5">
              <div className="flex items-center gap-2">
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: SOURCE_COLORS[index % SOURCE_COLORS.length] }}
                />
                <span className="min-w-0 flex-1 truncate text-[13px]" title={file.name}>
                  {file.name}
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between pl-4">
                <span className="tnum text-xs text-ink-muted">
                  {file.pageCount} 页{usedCount(file.fileId) > 0 && ` · 已加入 ${usedCount(file.fileId)}`}
                </span>
                <Button size="sm" onClick={() => addFilePages(file)}>
                  <Plus size={15} />
                  加入
                </Button>
              </div>
            </div>
          ))}
          <label className="flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-dashed border-line py-3 text-xs text-ink-muted transition-colors hover:border-accent hover:text-accent">
            <FileUp size={16} />
            导入更多 PDF / 图片
            <input
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              multiple
              className="hidden"
              onChange={(event) => {
                const picked = Array.from(event.currentTarget.files ?? [])
                event.currentTarget.value = ''
                if (picked.length > 0) void importAsNewProject(picked)
              }}
            />
          </label>
        </div>
      </div>
    </aside>
  )
}

type Press = {
  key: string
  startX: number
  startY: number
  grabDX: number
  grabDY: number
  w: number
  h: number
  active: boolean
}

type DragGhost = { key: string; x: number; y: number; w: number; h: number }

function PageGrid({
  items,
  files,
  docs,
  multiSource
}: {
  items: OrgItem[]
  files: PDFFile[]
  docs: Map<string, PDFDocumentProxy>
  multiSource: boolean
}) {
  const setItems = useOrganize((state) => state.setItems)
  const remove = useOrganize((state) => state.remove)
  const cardRefs = useRef(new Map<string, HTMLDivElement>())
  const prevRects = useRef(new Map<string, DOMRect>())
  const press = useRef<Press | null>(null)
  const raf = useRef(0)
  const [ghost, setGhost] = useState<DragGhost | null>(null)

  /* FLIP：每次渲染后，把位置变化的卡片从旧位置补间到新位置 */
  useLayoutEffect(() => {
    for (const [key, el] of cardRefs.current) {
      const next = el.getBoundingClientRect()
      const prev = prevRects.current.get(key)
      if (prev) {
        const dx = prev.left - next.left
        const dy = prev.top - next.top
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
          el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
            duration: 230,
            easing: 'cubic-bezier(0.2, 0, 0, 1)'
          })
        }
      }
      prevRects.current.set(key, next)
    }
  })

  function reorderAt(clientX: number, clientY: number) {
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => {
      const state = press.current
      if (!state?.active) return
      const current = useOrganize.getState().items
      const from = current.findIndex((item) => item.key === state.key)
      if (from < 0) return
      let target = -1
      for (let i = 0; i < current.length; i++) {
        if (current[i].key === state.key) continue
        const el = cardRefs.current.get(current[i].key)
        if (!el) continue
        const rect = el.getBoundingClientRect()
        if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
          target = clientX < rect.left + rect.width / 2 ? i : i + 1
          break
        }
      }
      if (target < 0) {
        const lastKey = current[current.length - 1]?.key
        const lastEl = lastKey ? cardRefs.current.get(lastKey) : null
        if (lastEl && clientY > lastEl.getBoundingClientRect().bottom) target = current.length
        else return
      }
      let to = target
      if (from < to) to -= 1
      if (to === from) return
      const next = [...current]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      setItems(next)
    })
  }

  function onPointerDown(event: React.PointerEvent, item: OrgItem) {
    if (event.button !== 0) return
    const el = cardRefs.current.get(item.key)
    if (!el) return
    const rect = el.getBoundingClientRect()
    event.currentTarget.setPointerCapture(event.pointerId)
    press.current = {
      key: item.key,
      startX: event.clientX,
      startY: event.clientY,
      grabDX: event.clientX - rect.left,
      grabDY: event.clientY - rect.top,
      w: rect.width,
      h: rect.height,
      active: false
    }
  }

  function onPointerMove(event: React.PointerEvent) {
    const state = press.current
    if (!state) return
    if (!state.active) {
      if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < 5) return
      state.active = true
    }
    setGhost({
      key: state.key,
      x: event.clientX - state.grabDX,
      y: event.clientY - state.grabDY,
      w: state.w,
      h: state.h
    })
    reorderAt(event.clientX, event.clientY)
  }

  function onPointerUp(event: React.PointerEvent) {
    if (!press.current) return
    ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
    press.current = null
    cancelAnimationFrame(raf.current)
    setGhost(null)
  }

  if (items.length === 0) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center bg-sunken/50">
        <p className="text-sm text-ink-muted">从左侧把文件的页面加进来，开始整理。</p>
      </div>
    )
  }

  const fileIndex = (fileId: string) => files.findIndex((file) => file.fileId === fileId)
  const ghostItem = ghost ? items.find((item) => item.key === ghost.key) : null

  return (
    <div className="scroll-slim min-w-0 flex-1 overflow-y-auto bg-sunken/50 p-4">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-3">
        {items.map((item, index) => (
          <PageCard
            key={item.key}
            item={item}
            order={index + 1}
            doc={docs.get(item.fileId)}
            sourceColor={multiSource ? SOURCE_COLORS[Math.max(0, fileIndex(item.fileId)) % SOURCE_COLORS.length] : null}
            sourceName={files.find((file) => file.fileId === item.fileId)?.name ?? ''}
            dragging={ghost?.key === item.key}
            registerRef={(el) => {
              if (el) cardRefs.current.set(item.key, el)
              else cardRefs.current.delete(item.key)
            }}
            onPointerDown={(event) => onPointerDown(event, item)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onRemove={() => remove(item.key)}
          />
        ))}
      </div>
      {ghost &&
        ghostItem &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[130] rotate-2 opacity-95"
            style={{ left: ghost.x, top: ghost.y, width: ghost.w }}
          >
            <GhostCard item={ghostItem} doc={docs.get(ghostItem.fileId)} />
          </div>,
          document.body
        )}
    </div>
  )
}

function PageCard({
  item,
  order,
  doc,
  sourceColor,
  sourceName,
  dragging,
  registerRef,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onRemove
}: {
  item: OrgItem
  order: number
  doc: PDFDocumentProxy | undefined
  sourceColor: string | null
  sourceName: string
  dragging: boolean
  registerRef: (el: HTMLDivElement | null) => void
  onPointerDown: (event: React.PointerEvent) => void
  onPointerMove: (event: React.PointerEvent) => void
  onPointerUp: (event: React.PointerEvent) => void
  onRemove: () => void
}) {
  const thumb = useOrgThumb(doc, item.fileId, item.pageNumber)
  return (
    <div
      ref={registerRef}
      className={cx(
        'group relative touch-none select-none rounded-xl border bg-panel p-1.5 transition-shadow',
        dragging ? 'border-dashed border-accent/60 opacity-35' : 'border-line cursor-grab hover:shadow-pop active:cursor-grabbing'
      )}
      title={`${sourceName} · 第 ${item.pageNumber} 页（拖动换位）`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="overflow-hidden rounded-lg border border-line/70 bg-white">
        {thumb ? (
          <img src={thumb} alt="" draggable={false} className="block h-auto w-full" />
        ) : (
          <div className="flex aspect-[1/1.41] items-center justify-center text-ink-muted/50">
            <Loader2 size={16} className="animate-spin" />
          </div>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between px-0.5">
        <span className="tnum text-[11px] font-medium text-ink">{order}</span>
        <span className="tnum flex items-center gap-1 text-[11px] text-ink-muted">
          {sourceColor && <span className="size-2 rounded-full" style={{ background: sourceColor }} />}P
          {item.pageNumber}
        </span>
      </div>
      <Tip label="移除该页">
        <button
          type="button"
          className="absolute right-0.5 top-0.5 hidden size-6 items-center justify-center rounded-md bg-panel/95 text-ink-muted shadow-sm transition-colors hover:text-accent group-hover:flex"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onRemove}
          aria-label="移除该页"
        >
          <X size={15} />
        </button>
      </Tip>
    </div>
  )
}

function GhostCard({ item, doc }: { item: OrgItem; doc: PDFDocumentProxy | undefined }) {
  const thumb = useOrgThumb(doc, item.fileId, item.pageNumber)
  return (
    <div className="rounded-xl border border-accent bg-panel p-1.5 shadow-pop">
      <div className="overflow-hidden rounded-lg bg-white">
        {thumb && <img src={thumb} alt="" className="block h-auto w-full" />}
      </div>
    </div>
  )
}
