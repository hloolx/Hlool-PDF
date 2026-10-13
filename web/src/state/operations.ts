import { useEditorStore } from './store'
import { toast } from './toasts'

let owner: symbol | undefined

/** Acquire synchronously before the first await so menus and shortcuts cannot overlap jobs. */
export function beginOperation(label: string) {
  if (useEditorStore.getState().busy) {
    toast('请等待当前操作完成后再试。')
    return null
  }
  const token = Symbol(label)
  owner = token
  let lastLabel = label
  useEditorStore.getState().setBusy(label)
  return {
    setBusy(next: string) {
      if (owner !== token || useEditorStore.getState().busy !== lastLabel) return
      lastLabel = next
      useEditorStore.getState().setBusy(next)
    },
    end() {
      if (owner !== token) return
      owner = undefined
      if (useEditorStore.getState().busy === lastLabel) useEditorStore.getState().setBusy('')
    }
  }
}
