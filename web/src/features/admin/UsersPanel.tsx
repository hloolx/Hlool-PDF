import { useEffect, useState } from 'react'
import { KeyRound, Loader2, Trash2, UserX } from 'lucide-react'
import { errorText } from '../../lib/api'
import { cx } from '../../lib/cx'
import { toast } from '../../state/toasts'
import { Button, ConfirmButton } from '../../ui/Button'
import { Field, TextInput } from '../../ui/Field'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/Popover'
import { useAuth } from '../auth/useAuth'
import { cleanupGuests, deleteUser, listUsers, resetUserPassword, type AdminUser } from './api'

/** 管理台「用户」面板：列表 + 重置密码（吊销会话）+ 删除（连库焚毁）+ 清理游客。 */
export function UsersPanel() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [cleaning, setCleaning] = useState(false)
  const me = useAuth((state) => state.user)

  async function reload() {
    setLoading(true)
    try {
      setUsers(await listUsers())
    } catch (err) {
      toast(`加载用户失败：${errorText(err)}`, { kind: 'error' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  async function runCleanup(all: boolean) {
    setCleaning(true)
    try {
      const result = await cleanupGuests(all)
      toast(
        result.burned > 0
          ? `已清理 ${result.burned} 个游客${result.failed > 0 ? `，${result.failed} 个失败` : ''}`
          : '没有需要清理的游客',
        { kind: result.failed > 0 ? 'error' : 'success' }
      )
      void reload()
    } catch (err) {
      toast(`清理失败：${errorText(err)}`, { kind: 'error' })
    } finally {
      setCleaning(false)
    }
  }

  async function removeUser(user: AdminUser) {
    try {
      await deleteUser(user.id)
      setUsers((items) => items.filter((item) => item.id !== user.id))
      toast(`已删除 ${displayName(user)} 及其印章库`, { kind: 'success' })
    } catch (err) {
      toast(`删除失败：${errorText(err)}`, { kind: 'error' })
    }
  }

  const guests = users.filter((user) => user.isGuest).length
  const admins = users.filter((user) => user.isAdmin).length

  return (
    <section className="min-w-0 rounded-lg border border-line bg-panel">
      <div className="flex flex-col gap-2 border-b border-line px-4 py-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold">用户</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            共 {users.length} 个 · 注册 {users.length - guests} · 游客 {guests} · 管理员 {admins}
            {users.length >= 1000 && ' · 仅显示最近 1000 个'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" disabled={cleaning} onClick={() => void runCleanup(false)} title="等价于后台自动清扫：只清理创建超过约 24 小时的游客">
            <UserX size={15} />
            清理过期游客
          </Button>
          <ArmedTextButton
            label="清空全部游客"
            confirmLabel="再点一次：连活跃游客一起焚毁"
            disabled={cleaning || guests === 0}
            onConfirm={() => void runCleanup(true)}
          />
          <Button size="sm" disabled={loading} onClick={() => void reload()}>
            {loading ? <Loader2 size={15} className="animate-spin" /> : null}
            刷新
          </Button>
        </div>
      </div>

      {users.length === 0 && !loading ? (
        <div className="px-4 py-8 text-center text-sm text-ink-muted">还没有用户。</div>
      ) : (
        <div className="max-h-[480px] overflow-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-[13px]">
            <thead className="sticky top-0 z-10 bg-sunken text-xs text-ink-muted">
              <tr>
                <th className="px-4 py-2 font-medium">用户</th>
                <th className="px-3 py-2 font-medium">类型</th>
                <th className="hidden px-3 py-2 font-medium sm:table-cell">创建时间</th>
                <th className="px-3 py-2 font-medium">印章库</th>
                <th className="px-3 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const self = me != null && user.username.toLowerCase() === me.username.toLowerCase()
                return (
                  <tr key={user.id} className="border-t border-line/70">
                    <td className="max-w-[240px] px-4 py-2">
                      <span className={cx('block truncate', user.isGuest && 'font-mono text-xs text-ink-muted')} title={user.username}>
                        {displayName(user)}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <TypePill user={user} self={self} />
                    </td>
                    <td className="tnum hidden whitespace-nowrap px-3 py-2 text-ink-muted sm:table-cell">
                      {formatDateTime(user.createdAt)}
                    </td>
                    <td className="tnum whitespace-nowrap px-3 py-2 text-ink-muted">
                      {user.stampCount} 个 · {formatBytes(user.libraryBytes)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-0.5">
                        {!user.isGuest && !self && <ResetPasswordPopover user={user} />}
                        {!self && (
                          <ConfirmButton
                            title="删除用户（印章库一起焚毁）"
                            confirmLabel="再点一次删除"
                            onConfirm={() => void removeUser(user)}
                          >
                            <Trash2 size={15} />
                          </ConfirmButton>
                        )}
                        {self && <span className="pr-1 text-xs text-ink-muted">当前登录</span>}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function ResetPasswordPopover({ user }: { user: AdminUser }) {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (password.length < 8) {
      toast('新密码至少 8 位。', { kind: 'error' })
      return
    }
    setBusy(true)
    try {
      await resetUserPassword(user.id, password)
      toast(`已重置 ${user.username} 的密码，其所有会话已吊销`, { kind: 'success' })
      setOpen(false)
      setPassword('')
    } catch (err) {
      toast(`重置失败：${errorText(err)}`, { kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" title="重置密码并吊销其所有会话">
          <KeyRound size={15} />
          重置密码
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <form className="grid gap-2.5" onSubmit={submit}>
          <Field label={`为 ${user.username} 设置新密码`} hint="至少 8 位；重置后该用户所有已登录会话立即失效。">
            <TextInput
              type="password"
              autoFocus
              value={password}
              placeholder="新密码"
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
          </Field>
          <Button type="submit" variant="primary" size="sm" disabled={busy || password.length === 0}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            重置并吊销会话
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}

/** 文字版两段确认按钮（ConfirmButton 是图标专用）。 */
function ArmedTextButton({
  label,
  confirmLabel,
  disabled,
  onConfirm
}: {
  label: string
  confirmLabel: string
  disabled?: boolean
  onConfirm: () => void
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 2600)
    return () => window.clearTimeout(timer)
  }, [armed])
  return (
    <Button
      size="sm"
      variant="danger"
      disabled={disabled}
      className={cx(armed && 'anim-confirm bg-accent text-white hover:bg-accent-hover')}
      onClick={() => {
        if (armed) {
          setArmed(false)
          onConfirm()
        } else {
          setArmed(true)
        }
      }}
    >
      {armed ? confirmLabel : label}
    </Button>
  )
}

function TypePill({ user, self }: { user: AdminUser; self: boolean }) {
  const label = user.isAdmin ? '管理员' : user.isGuest ? '游客' : '注册用户'
  return (
    <span
      className={cx(
        'inline-flex h-6 items-center whitespace-nowrap rounded-full px-2 text-xs',
        user.isAdmin ? 'bg-accent-soft text-accent' : 'bg-sunken text-ink-muted'
      )}
      title={self ? '当前登录的账号' : undefined}
    >
      {label}
    </span>
  )
}

function displayName(user: AdminUser): string {
  if (!user.isGuest) return user.username
  // 游客的合成用户名形如 guest:<32hex>，展示成短尾号便于对照日志。
  const id = user.username.replace(/^guest:/, '')
  return `游客 ${id.slice(0, 8)}`
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024)
    return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`
  }
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}
