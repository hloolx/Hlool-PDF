import { useEffect } from 'react'
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react'
import {
  activeFile,
  leftDocked,
  leftPanelOpen,
  rightDocked,
  rightPanelOpen,
  useEditorStore
} from '../state/store'
import { cx } from '../lib/cx'
import { Tip, TipProvider } from '../ui/Tooltip'
import { ToastHost } from '../ui/ToastHost'
import { usePdfDocument } from '../features/viewer/usePdfDocument'
import { Viewer } from '../features/viewer/Viewer'
import { Thumbnails } from '../features/thumbnails/Thumbnails'
import { StampShelf } from '../features/stamps/Shelf'
import { Inspector } from '../features/inspector/Inspector'
import { GhostLayer } from '../features/placements/GhostLayer'
import { ThemeFxLayer } from '../features/theme/ThemeFx'
import { WindowDropZone } from '../features/workspace/WindowDropZone'
import { ImportChoiceDialog } from '../features/workspace/ImportChoiceDialog'
import { PasswordDialog } from '../features/workspace/PasswordDialog'
import { ShortcutHelp } from '../features/help/ShortcutHelp'
import { TopBar } from './TopBar'
import { useGlobalKeys } from './useGlobalKeys'

/**
 * 已认证后的主工作区。单独成模块以便 App 用 React.lazy 切包：
 * pdfjs / 画布 / 检查器等重依赖随本模块进入独立 chunk，不进入认证前的入口包。
 */
export default function Workspace() {
  const file = useEditorStore(activeFile)
  const { doc, error } = usePdfDocument(file?.blob ?? null, file?.password)
  const leftDock = useEditorStore(leftDocked)
  const rightDock = useEditorStore(rightDocked)
  const showLeft = useEditorStore(leftPanelOpen)
  const showRight = useEditorStore(rightPanelOpen)
  const mobilePanel = useEditorStore((state) => state.mobilePanel)
  const setViewportWidth = useEditorStore((state) => state.setViewportWidth)
  const closeMobilePanel = useEditorStore((state) => state.closeMobilePanel)
  const toggleLeftPanel = useEditorStore((state) => state.toggleLeftPanel)
  const toggleRightPanel = useEditorStore((state) => state.toggleRightPanel)
  useGlobalKeys()

  // 跟踪视口宽度：决定侧栏停靠还是浮层。
  useEffect(() => {
    const update = () => {
      const w = window.innerWidth
      if (w !== useEditorStore.getState().viewportWidth) setViewportWidth(w)
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [setViewportWidth])

  // 任一侧未停靠（窄屏）时启用浮层抽屉 + 遮罩。
  const hasDrawer = !leftDock || !rightDock

  return (
    <TipProvider>
      <div className="flex h-full flex-col">
        <TopBar />
        <div className="relative flex min-h-0 flex-1">
          {leftDock && (
            <div
              className={cx(
                'relative shrink-0 overflow-hidden transition-[width] duration-[var(--dur-base)] ease-[var(--ease-out)]',
                showLeft ? 'w-[208px]' : 'w-0'
              )}
            >
              <aside
                className={cx(
                  'flex h-full w-[208px] flex-col border-r border-line bg-panel transition-opacity duration-[var(--dur-base)] ease-[var(--ease-out)]',
                  showLeft ? 'opacity-100' : 'opacity-0'
                )}
              >
                <Thumbnails doc={doc} />
                <StampShelf />
              </aside>
              {showLeft && (
                <SidePanelHandle
                  side="left"
                  open
                  label="收起缩略图与印章架"
                  onClick={() => toggleLeftPanel(false)}
                />
              )}
            </div>
          )}
          {leftDock && !showLeft && (
            <SidePanelHandle
              side="left"
              open={false}
              label="拉出缩略图与印章架"
              onClick={() => toggleLeftPanel(true)}
            />
          )}
          <Viewer doc={doc} error={error} />
          {rightDock && (
            <div
              className={cx(
                'relative shrink-0 overflow-hidden transition-[width] duration-[var(--dur-base)] ease-[var(--ease-out)]',
                showRight ? 'w-[286px]' : 'w-0'
              )}
            >
              <Inspector
                className={cx(
                  'h-full transition-opacity duration-[var(--dur-base)] ease-[var(--ease-out)]',
                  showRight ? 'opacity-100' : 'opacity-0'
                )}
              />
              {showRight && (
                <SidePanelHandle
                  side="right"
                  open
                  label="收起属性检查器"
                  onClick={() => toggleRightPanel(false)}
                />
              )}
            </div>
          )}
          {rightDock && !showRight && (
            <SidePanelHandle
              side="right"
              open={false}
              label="拉出属性检查器"
              onClick={() => toggleRightPanel(true)}
            />
          )}

          {/* 窄屏：侧栏浮在画布上方，点遮罩收起 */}
          {hasDrawer && (
            <div
              className={cx(
                'absolute inset-0 z-30 bg-ink/30 transition-opacity duration-[var(--dur-base)] ease-[var(--ease-out)]',
                mobilePanel ? 'opacity-100' : 'pointer-events-none opacity-0'
              )}
              onClick={closeMobilePanel}
              aria-hidden
            />
          )}
          {!leftDock && (
            <aside
              className={cx(
                'absolute inset-y-0 left-0 z-40 flex w-[208px] max-w-[80vw] flex-col border-r border-line bg-panel shadow-pop transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]',
                mobilePanel === 'left' ? 'translate-x-0' : 'pointer-events-none -translate-x-[110%]'
              )}
            >
              <Thumbnails doc={doc} />
              <StampShelf />
            </aside>
          )}
          {!rightDock && (
            <Inspector
              className={cx(
                'absolute inset-y-0 right-0 z-40 max-w-[80vw] shadow-pop transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]',
                mobilePanel === 'right' ? 'translate-x-0' : 'pointer-events-none translate-x-[110%]'
              )}
            />
          )}
        </div>
      </div>
      <GhostLayer />
      <WindowDropZone />
      <ImportChoiceDialog />
      <PasswordDialog />
      <ShortcutHelp />
      <ThemeFxLayer />
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2">
        <ToastHost />
      </div>
    </TipProvider>
  )
}

function SidePanelHandle({
  side,
  open,
  label,
  onClick
}: {
  side: 'left' | 'right'
  open: boolean
  label: string
  onClick: () => void
}) {
  const Icon = side === 'left' ? (open ? PanelLeftClose : PanelLeftOpen) : open ? PanelRightClose : PanelRightOpen
  const tooltipSide = side === 'left' ? 'right' : 'left'
  const positionClass =
    side === 'left'
      ? open
        ? 'right-0 rounded-l-full border-y border-l'
        : 'left-0 rounded-r-full border-y border-r'
      : open
        ? 'left-0 rounded-r-full border-y border-r'
        : 'right-0 rounded-l-full border-y border-l'

  return (
    <Tip label={label} side={tooltipSide}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={open}
        className={cx(
          'absolute top-1/2 z-20 flex h-16 w-8 -translate-y-1/2 items-center justify-center border-line bg-panel text-ink-muted shadow-sm transition duration-150 hover:bg-sunken hover:text-accent hover:opacity-100 active:scale-[0.98] focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/60',
          open && 'opacity-0',
          positionClass
        )}
        onClick={onClick}
      >
        <Icon size={20} aria-hidden />
      </button>
    </Tip>
  )
}
