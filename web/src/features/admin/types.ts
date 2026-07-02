export type ProviderKind = 'matting' | 'mail' | 'oauth' | 'storage'

export interface Provider {
  id: string
  kind: ProviderKind
  name: string
  enabled: boolean
  baseURL: string
  model: string
  publicConfig: Record<string, unknown>
  secretConfig: Record<string, unknown>
  createdAt: string
  updatedAt: string
}
