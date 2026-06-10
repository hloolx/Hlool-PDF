import { create } from 'zustand'

/** 印章架拖拽 / 上膏模式下跟随光标的影像状态。 */
type GhostState = {
  dragStampId: string | null
  x: number
  y: number
  tracked: boolean
  startDrag: (stampId: string, x: number, y: number) => void
  move: (x: number, y: number) => void
  endDrag: () => void
}

export const useGhost = create<GhostState>((set) => ({
  dragStampId: null,
  x: 0,
  y: 0,
  tracked: false,
  startDrag: (stampId, x, y) => set({ dragStampId: stampId, x, y, tracked: true }),
  move: (x, y) => set({ x, y, tracked: true }),
  endDrag: () => set({ dragStampId: null, tracked: false })
}))
