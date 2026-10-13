import { test, expect } from '@playwright/test'

test('clearing the last document configuration removes it from recovery storage', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: '本地资料', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const { useEditorStore } = await import('/src/state/store.ts')
    const { emptyConfig } = await import('/src/lib/types.ts')
    const file = { fileId: 'recovery-test', fingerprint: 'recovery-test', name: 'test.pdf', size: 1, pageCount: 1, pages: [], createdAt: new Date().toISOString(), blob: new Blob(['test']) }
    useEditorStore.setState({ files: [file], activeFileId: null, configs: { [file.fileId]: { ...emptyConfig(), scanEnabled: true } } })
  })
  await expect.poll(() => page.evaluate(() => localStorage.getItem('hlool-pdf:file-configs-v1'))).toContain('recovery-test')
  await page.evaluate(async () => {
    const { useEditorStore } = await import('/src/state/store.ts')
    const { emptyConfig } = await import('/src/lib/types.ts')
    useEditorStore.getState().setConfig('recovery-test', emptyConfig())
  })
  await expect.poll(() => page.evaluate(() => localStorage.getItem('hlool-pdf:file-configs-v1'))).toBeNull()
})

test('malformed recovered configurations cannot break document import', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: '本地资料', exact: true })).toBeVisible()
  const result = await page.evaluate(async () => {
    const { useEditorStore } = await import('/src/state/store.ts')
    const { emptyConfig, DEFAULT_SCAN } = await import('/src/lib/types.ts')
    const { restoreConfigs } = await import('/src/features/workspace/configVault.ts')
    const file = { fileId: 'broken-recovery', fingerprint: 'broken-recovery', name: 'test.pdf', size: 1, pageCount: 1, pages: [], createdAt: new Date().toISOString(), blob: new Blob(['test']) }
    localStorage.setItem('hlool-pdf:file-configs-v1', JSON.stringify({ [file.fingerprint]: { savedAt: Date.now(), config: { placements: 'corrupt', seamEnabled: true, seam: { pages: 42 }, scanEnabled: true, scanConfig: { scale: 'corrupt' } } } }))
    useEditorStore.setState({ configs: { [file.fileId]: emptyConfig() } })
    restoreConfigs([file])
    const config = useEditorStore.getState().configs[file.fileId]
    return { placements: config.placements, seam: config.seamEnabled, scale: config.scanConfig?.scale, expected: DEFAULT_SCAN.scale }
  })
  expect(result.placements).toEqual([])
  expect(result.seam).toBe(false)
  expect(result.scale).toBe(result.expected)
})
