import { useEffect } from 'react'
import { isEditingField } from '../lib/dom'
import { mmToPt } from '../lib/units'
import { activeFile, redo, selectedPlacement, undo, useEditorStore } from '../state/store'
import { generateCurrent } from '../features/jobs/actions'
import { duplicatePlacement, nudgeSelected } from '../features/placements/actions'
import { useGhost } from '../features/placements/ghost'
import { scrollToPage } from '../features/viewer/pageRegistry'

/**
 * 全局快捷键：
 * Ctrl+Z/Y 撤销重做 · 方向键微移(Shift 大步) · Ctrl+D 复制 · Del 删除
 * Esc 退出/取消选中 · PgUp/PgDn/Home/End 翻页 · Ctrl+Enter 生成
 */
export function useGlobalKeys() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.ctrlKey || event.metaKey
      if (isEditingField(document.activeElement)) {
        if (event.key === 'Escape') (document.activeElement as HTMLElement).blur()
        return
      }
      const state = useEditorStore.getState()

      if (mod && (event.key === 'z' || event.key === 'Z')) {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (mod && (event.key === 'y' || event.key === 'Y')) {
        event.preventDefault()
        redo()
        return
      }
      if (mod && event.key === 'Enter') {
        event.preventDefault()
        void generateCurrent()
        return
      }
      if (mod && (event.key === 'd' || event.key === 'D')) {
        const placement = selectedPlacement(state)
        if (placement) {
          event.preventDefault()
          duplicatePlacement(placement)
        }
        return
      }

      switch (event.key) {
        case 'Escape': {
          state.arm(null)
          state.select(null)
          useGhost.getState().endDrag()
          return
        }
        case 'Delete':
        case 'Backspace': {
          if (state.selection?.kind === 'placement') {
            event.preventDefault()
            state.removePlacement(state.selection.id)
          } else if (state.selection?.kind === 'seam') {
            event.preventDefault()
            state.setSeamEnabled(false)
          }
          return
        }
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          const step = mmToPt(event.shiftKey ? 5 : 0.5)
          const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
          const dy = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0
          if (nudgeSelected(dx, dy)) event.preventDefault()
          return
        }
        case 'PageDown':
        case 'PageUp': {
          const file = activeFile(state)
          if (!file) return
          event.preventDefault()
          const next =
            event.key === 'PageDown'
              ? Math.min(file.pageCount, state.currentPage + 1)
              : Math.max(1, state.currentPage - 1)
          state.setCurrentPage(next)
          scrollToPage(next)
          return
        }
        case 'Home':
        case 'End': {
          const file = activeFile(state)
          if (!file) return
          event.preventDefault()
          const next = event.key === 'Home' ? 1 : file.pageCount
          state.setCurrentPage(next)
          scrollToPage(next)
          return
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
