import { activeFile, selectedPlacement, useEditorStore } from '../../state/store'
import { cx } from '../../lib/cx'
import { DocumentPanel } from './DocumentPanel'
import { PlacementInspector } from './PlacementInspector'
import { SeamInspector } from './SeamInspector'

/** 右侧上下文检查器：内容由当前选中对象决定。 */
export function Inspector({ className }: { className?: string } = {}) {
  const file = useEditorStore(activeFile)
  const placement = useEditorStore(selectedPlacement)
  const seamSelected = useEditorStore((state) => state.selection?.kind === 'seam')

  return (
    <aside className={cx('flex w-[286px] shrink-0 flex-col border-l border-line bg-panel', className)}>
      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {!file ? (
          <p className="py-10 text-center text-xs leading-relaxed text-ink-muted">
            导入 PDF 后，这里会显示
            <br />
            文档信息与所选对象的属性。
          </p>
        ) : placement ? (
          <PlacementInspector placement={placement} file={file} />
        ) : seamSelected ? (
          <SeamInspector file={file} />
        ) : (
          <DocumentPanel file={file} />
        )}
      </div>
    </aside>
  )
}
