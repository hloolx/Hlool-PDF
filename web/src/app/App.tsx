import { useEffect } from 'react'
import { activeFile, fileContentSrc, useEditorStore } from '../state/store'
import { TipProvider } from '../ui/Tooltip'
import { ToastHost } from '../ui/ToastHost'
import { usePdfDocument } from '../features/viewer/usePdfDocument'
import { Viewer } from '../features/viewer/Viewer'
import { Thumbnails } from '../features/thumbnails/Thumbnails'
import { StampShelf } from '../features/stamps/Shelf'
import { Inspector } from '../features/inspector/Inspector'
import { GhostLayer } from '../features/placements/GhostLayer'
import { JobsOverlay } from '../features/jobs/JobsOverlay'
import { PreviewDialog } from '../features/jobs/PreviewDialog'
import { HistoryDrawer } from '../features/jobs/HistoryDrawer'
import { ThemeFxLayer } from '../features/theme/ThemeFx'
import { WindowDropZone } from '../features/workspace/WindowDropZone'
import { ImportChoiceDialog } from '../features/workspace/ImportChoiceDialog'
import { PasswordDialog } from '../features/workspace/PasswordDialog'
import { refreshWorkspace } from '../features/workspace/actions'
import { TopBar } from './TopBar'
import { useGlobalKeys } from './useGlobalKeys'

export function App() {
  const theme = useEditorStore((state) => state.theme)
  const file = useEditorStore(activeFile)
  const src = useEditorStore((state) => {
    const active = activeFile(state)
    return active ? fileContentSrc(state, active.fileId) : null
  })
  const { doc, error } = usePdfDocument(src)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    void refreshWorkspace()
  }, [])

  useGlobalKeys()

  return (
    <TipProvider>
      <div className="flex h-full flex-col">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[208px] shrink-0 flex-col border-r border-line bg-panel">
            <Thumbnails doc={doc} />
            <StampShelf />
          </aside>
          <Viewer doc={doc} error={error} />
          <Inspector />
        </div>
      </div>
      <GhostLayer />
      <WindowDropZone />
      <ImportChoiceDialog />
      <PasswordDialog />
      <PreviewDialog />
      <HistoryDrawer />
      <ThemeFxLayer />
      <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2">
        <JobsOverlay />
        <ToastHost />
      </div>
    </TipProvider>
  )
}
