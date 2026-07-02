import { useRef } from 'react'
import {
  ChevronDown,
  FileText,
  FileUp,
  Keyboard,
  Layers,
  Loader2,
  LogOut,
  MoreHorizontal,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Play,
  Redo2,
  ShieldCheck,
  Sun,
  Trash2,
  Undo2,
  UserPlus,
  UserRound,
  ZoomIn
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { cx } from '../lib/cx'
import {
  activeConfig,
  activeFile,
  configuredFiles,
  hasConfig,
  leftPanelOpen,
  redo,
  rightPanelOpen,
  switchFile,
  undo,
  useEditorStore,
  useTemporal
} from '../state/store'
import { Button, ConfirmButton, IconButton } from '../ui/Button'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '../ui/Menu'
import { Tip } from '../ui/Tooltip'
import { generateAll, generateCurrent, generationStatus, outputNameFor } from '../features/generate/actions'
import { toggleTheme } from '../features/theme/ThemeFx'
import { applyConfigToAllFiles, deleteFileAction, importPicked } from '../features/workspace/actions'
import { logout } from '../features/auth/api'
import { useAuth } from '../features/auth/useAuth'
import { resetSettingsSync } from '../features/library/settings'
import { useShortcutHelp } from '../features/help/ShortcutHelp'

function TopBarDivider() {
  return <span className="mx-1.5 h-5 w-px shrink-0 bg-line" aria-hidden />
}

export function TopBar() {
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-1.5 border-b border-line bg-panel px-3">
      <BrandLeftPanelToggle />
      <FileMenu />
      <BusyChip />
      <div className="flex-1" />
      <div className="hidden items-center gap-1.5 md:flex">
        <UndoRedo />
        <TopBarDivider />
        <ZoomMenu />
        <TopBarDivider />
        <HelpButton />
        <ThemeToggle />
        <UserMenu />
        <RightPanelToggle />
        <TopBarDivider />
      </div>
      <div className="flex items-center gap-1.5 md:hidden">
        <UserMenu />
        <MobileMoreMenu />
      </div>
      <GenerateSplitButton />
    </header>
  )
}

function BrandLeftPanelToggle() {
  const open = useEditorStore(leftPanelOpen)
  const toggle = useEditorStore((state) => state.toggleLeftPanel)
  const Icon = open ? PanelLeftClose : PanelLeftOpen
  const label = open ? '收起缩略图与印章架' : '拉出缩略图与印章架'

  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={open}
        className="group flex h-10 shrink-0 items-center gap-2 rounded-lg pl-1 pr-2 text-left transition duration-150 hover:bg-sunken active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/60"
        onClick={() => toggle()}
      >
        <span className="anim-stamp-press relative flex size-7 -rotate-3 items-center justify-center overflow-hidden rounded-lg bg-accent text-xs font-bold text-white shadow-sm">
          <span className="transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0">印</span>
          <Icon
            size={18}
            className="absolute opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
            aria-hidden
          />
          <span className="pointer-events-none absolute inset-[2.5px] rounded-md border border-white/40" aria-hidden />
        </span>
        <span className="hidden text-[13px] font-semibold tracking-wide sm:inline">hlool pdf</span>
      </button>
    </Tip>
  )
}

function RightPanelToggle() {
  const open = useEditorStore(rightPanelOpen)
  const toggle = useEditorStore((state) => state.toggleRightPanel)
  return (
    <Tip label={open ? '隐藏属性检查器' : '显示属性检查器'}>
      <IconButton aria-label="切换右侧面板" aria-pressed={open} onClick={() => toggle()}>
        <PanelRight size={20} className={cx(!open && 'text-ink-muted')} />
      </IconButton>
    </Tip>
  )
}

function HelpButton() {
  const toggle = useShortcutHelp((state) => state.toggle)
  return (
    <Tip label="键盘快捷键 (?)">
      <IconButton aria-label="键盘快捷键" onClick={toggle}>
        <Keyboard size={20} />
      </IconButton>
    </Tip>
  )
}

function BusyChip() {
  const busy = useEditorStore((state) => state.busy)
  if (!busy) return null
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-sunken px-2.5 py-1 text-xs text-ink-muted">
      <Loader2 size={15} className="animate-spin" />
      {busy}
    </span>
  )
}

function FileMenu() {
  const file = useEditorStore(activeFile)
  const files = useEditorStore((state) => state.files)
  const configs = useEditorStore((state) => state.configs)
  const inputRef = useRef<HTMLInputElement | null>(null)

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button className="max-w-[300px]">
            <FileText size={16} className="shrink-0 text-ink-muted" />
            <span className="truncate">{file ? file.name : '导入 PDF / 图片…'}</span>
            {file && <span className="tnum shrink-0 text-xs text-ink-muted">{file.pageCount} 页</span>}
            {files.length > 1 && (
              <span className="tnum shrink-0 rounded-full bg-sunken px-1.5 text-xs text-ink-muted">{files.length}</span>
            )}
            <ChevronDown size={15} className="shrink-0 text-ink-muted" />
          </Button>
        </MenuTrigger>
        <MenuContent align="start" className="w-[320px]">
          {files.length > 0 && <MenuLabel>文件列表（配置随文件保存，切换不丢失）</MenuLabel>}
          <div className="max-h-72 overflow-y-auto">
            {files.map((item) => (
              <MenuItem
                key={item.fileId}
                className={cx(item.fileId === file?.fileId && 'bg-sunken')}
                onSelect={() => switchFile(item.fileId)}
              >
                <span
                  className={cx(
                    'size-2 shrink-0 rounded-full',
                    hasConfig(configs[item.fileId]) ? 'bg-accent' : 'border border-ink-muted/50'
                  )}
                  title={hasConfig(configs[item.fileId]) ? '已配置印章' : '未配置'}
                />
                <span className="min-w-0 flex-1 truncate" title={item.name}>
                  {item.name}
                </span>
                <span className="tnum shrink-0 text-xs text-ink-muted">{item.pageCount} 页</span>
                <ConfirmButton
                  size="sm"
                  confirmLabel="再点一次移除"
                  title="移除文件"
                  onConfirm={() => deleteFileAction(item)}
                >
                  <Trash2 size={16} />
                </ConfirmButton>
              </MenuItem>
            ))}
          </div>
          {files.length > 0 && <MenuSeparator />}
          <MenuItem onSelect={() => inputRef.current?.click()}>
            <FileUp size={16} />
            导入 PDF / 图片…
          </MenuItem>
          <MenuItem disabled={files.length < 2 || !hasConfig(file ? configs[file.fileId] : undefined)} onSelect={applyConfigToAllFiles}>
            <Layers size={16} />
            将当前配置应用到其他文件
          </MenuItem>
        </MenuContent>
      </Menu>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ''
          if (files.length > 0) void importPicked(files)
        }}
      />
    </>
  )
}

function UndoRedo() {
  const { pastStates, futureStates } = useTemporal()
  return (
    <div className="flex items-center">
      <Tip label="撤销 (Ctrl+Z)">
        <IconButton disabled={pastStates.length === 0} onClick={() => undo()} aria-label="撤销">
          <Undo2 size={20} />
        </IconButton>
      </Tip>
      <Tip label="重做 (Ctrl+Shift+Z)">
        <IconButton disabled={futureStates.length === 0} onClick={() => redo()} aria-label="重做">
          <Redo2 size={20} />
        </IconButton>
      </Tip>
    </div>
  )
}

function ZoomMenu() {
  const zoom = useEditorStore((state) => state.zoom)
  const setZoom = useEditorStore((state) => state.setZoom)
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" className="tnum w-[72px] justify-center px-1">
          {Math.round(zoom * 100)}%
          <ChevronDown size={15} className="text-ink-muted" />
        </Button>
      </MenuTrigger>
      <MenuContent className="min-w-36">
        <MenuItem onSelect={() => setZoom(zoom, 'fit')}>适合宽度</MenuItem>
        <MenuItem onSelect={() => setZoom(1, '100')}>100%</MenuItem>
        <MenuItem onSelect={() => setZoom(1.25, '125')}>125%</MenuItem>
        <MenuItem onSelect={() => setZoom(1.5, '150')}>150%</MenuItem>
        <MenuSeparator />
        <MenuLabel>Ctrl + 滚轮可随时缩放</MenuLabel>
      </MenuContent>
    </Menu>
  )
}

function ThemeToggle() {
  const theme = useEditorStore((state) => state.theme)
  return (
    <Tip label={theme === 'light' ? '入夜（暗色主题）' : '天亮（亮色主题）'}>
      <IconButton onClick={toggleTheme} aria-label="切换主题">
        {theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}
      </IconButton>
    </Tip>
  )
}

async function signOut() {
  try {
    await logout()
  } catch {
    /* 即便请求失败也按本地登出处理 */
  }
  resetSettingsSync()
  useEditorStore.getState().resetWorkspace()
  useAuth.getState().setAnon()
}

function UserMenu() {
  const user = useAuth((state) => state.user)
  const setPromptLogin = useAuth((state) => state.setPromptLogin)
  const isGuest = user?.isGuest ?? false
  const isAdmin = user?.isAdmin ?? false
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton aria-label="账户">
          <span className="relative inline-flex">
            <UserRound size={20} className={cx(isGuest && 'text-ink-muted')} />
            {isGuest && (
              <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-accent ring-2 ring-panel" aria-hidden />
            )}
          </span>
        </IconButton>
      </MenuTrigger>
      <MenuContent className="min-w-52">
        {isGuest ? (
          <>
            <MenuLabel>临时身份 · 约 24 小时后清除</MenuLabel>
            <MenuSeparator />
            <MenuItem onSelect={() => setPromptLogin(true)}>
              <UserPlus size={16} />
              注册 / 登录以长期保存
            </MenuItem>
          </>
        ) : (
          <>
            <MenuLabel>{user?.username || '已登录'}</MenuLabel>
            <MenuSeparator />
            {isAdmin && (
              <MenuItem onSelect={() => (window.location.href = '/admin')}>
                <ShieldCheck size={16} />
                管理员后台
              </MenuItem>
            )}
            <MenuItem onSelect={() => void signOut()}>
              <LogOut size={16} />
              退出登录
            </MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  )
}

function MobileMoreMenu() {
  const { pastStates, futureStates } = useTemporal()
  const theme = useEditorStore((state) => state.theme)
  const open = useEditorStore(rightPanelOpen)
  const toggle = useEditorStore((state) => state.toggleRightPanel)
  const toggleHelp = useShortcutHelp((state) => state.toggle)
  const zoom = useEditorStore((state) => state.zoom)
  const setZoom = useEditorStore((state) => state.setZoom)

  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton aria-label="更多">
          <MoreHorizontal size={20} />
        </IconButton>
      </MenuTrigger>
      <MenuContent align="end" className="w-52">
        <MenuItem disabled={pastStates.length === 0} onSelect={() => undo()}>
          <Undo2 size={16} />
          撤销
        </MenuItem>
        <MenuItem disabled={futureStates.length === 0} onSelect={() => redo()}>
          <Redo2 size={16} />
          重做
        </MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={() => toggle()}>
          <PanelRight size={16} />
          {open ? '隐藏' : '显示'}属性面板
        </MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={() => setZoom(zoom, 'fit')}>
          <ZoomIn size={16} />
          缩放：{Math.round(zoom * 100)}%
        </MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={toggleHelp}>
          <Keyboard size={16} />
          快捷键
        </MenuItem>
        <MenuItem onSelect={toggleTheme}>
          {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
          {theme === 'light' ? '暗色' : '亮色'}主题
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

function GenerateSplitButton() {
  const status = useEditorStore(useShallow((state) => generationStatus(state)))
  const summary = useEditorStore(
    useShallow((state) => {
      const file = activeFile(state)
      const config = activeConfig(state)
      return {
        placementCount: config.placements.length,
        coverage: new Set(config.placements.map((p) => p.pageNumber)).size,
        seamEnabled: config.seamEnabled,
        encrypted: state.outputPassword !== '',
        outputName: file ? outputNameFor(state, file) : '',
        configuredCount: configuredFiles(state).length
      }
    })
  )
  const generating = useEditorStore((state) => state.busy.startsWith('正在生成'))

  return (
    <div className="flex">
      <Tip label={status.hint}>
        <Button
          variant="primary"
          className={cx('rounded-r-none', !status.ok && 'opacity-55')}
          disabled={generating}
          onClick={() => void generateCurrent()}
        >
          {generating ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
          生成
        </Button>
      </Tip>
      <Menu>
        <MenuTrigger asChild>
          <Button variant="primary" className="rounded-l-none border-l border-l-white/25 px-1.5" aria-label="生成选项">
            <ChevronDown size={16} />
          </Button>
        </MenuTrigger>
        <MenuContent className="w-80 max-w-[calc(100vw-1rem)] overflow-hidden">
          <div className="grid min-w-0 gap-1 px-2.5 py-2 text-xs text-ink-muted">
            <p className="flex min-w-0 items-center justify-between gap-2">
              <span className="shrink-0">普通章</span>
              <span className="tnum min-w-0 truncate text-right text-ink">
                {summary.placementCount} 个 · 覆盖 {summary.coverage} 页
              </span>
            </p>
            <p className="flex min-w-0 items-center justify-between gap-2">
              <span className="shrink-0">骑缝章</span>
              <span className="min-w-0 truncate text-right text-ink">{summary.seamEnabled ? '已启用' : '未启用'}</span>
            </p>
            <p className="flex min-w-0 items-center justify-between gap-2">
              <span className="shrink-0">输出加密</span>
              <span className="min-w-0 truncate text-right text-ink">{summary.encrypted ? 'AES-256' : '关'}</span>
            </p>
            {summary.outputName && (
              <p className="flex min-w-0 items-center gap-2">
                <span className="shrink-0">输出名</span>
                <span className="min-w-0 flex-1 truncate text-right text-ink" title={summary.outputName}>
                  {summary.outputName}
                </span>
              </p>
            )}
          </div>
          <MenuSeparator />
          <MenuItem disabled={!status.ok} onSelect={() => void generateCurrent()}>
            生成当前文件
          </MenuItem>
          <MenuItem disabled={summary.configuredCount === 0} onSelect={() => void generateAll()}>
            生成全部（{summary.configuredCount} 个已配置）
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  )
}
