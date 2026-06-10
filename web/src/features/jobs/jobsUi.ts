import { create } from 'zustand'
import type { Job } from '../../lib/types'

type BatchState = { total: number; submitted: number } | null

type JobsUiState = {
  sessionJobIds: string[]
  dismissed: string[]
  historyOpen: boolean
  previewJob: Job | null
  batch: BatchState
  markSession: (jobId: string) => void
  dismiss: (jobId: string) => void
  setHistoryOpen: (open: boolean) => void
  setPreviewJob: (job: Job | null) => void
  setBatch: (batch: BatchState) => void
  bumpBatch: () => void
}

export const useJobsUi = create<JobsUiState>((set) => ({
  sessionJobIds: [],
  dismissed: [],
  historyOpen: false,
  previewJob: null,
  batch: null,
  markSession: (jobId) => set((state) => ({ sessionJobIds: [jobId, ...state.sessionJobIds].slice(0, 20) })),
  dismiss: (jobId) => set((state) => ({ dismissed: [...state.dismissed, jobId] })),
  setHistoryOpen: (historyOpen) => set({ historyOpen }),
  setPreviewJob: (previewJob) => set({ previewJob }),
  setBatch: (batch) => set({ batch }),
  bumpBatch: () => set((state) => (state.batch ? { batch: { ...state.batch, submitted: state.batch.submitted + 1 } } : {}))
}))
