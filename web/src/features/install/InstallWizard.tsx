import { useState } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import { errorText } from '../../lib/api'
import type { AuthUser } from '../../lib/types'
import { Button } from '../../ui/Button'
import { Field, TextInput } from '../../ui/Field'
import { Switch } from '../../ui/Switch'
import { installInstance } from '../auth/api'

/**
 * 首次安装向导(软引导):创建首个管理员 + 定两项核心访问开关。
 * 其余可选服务(AI 抠图 / SMTP / OAuth)不在这里重复表单,完成后去 /admin 配置。
 */
export function InstallWizard({
  tokenRequired,
  onDone,
  onSkip
}: {
  tokenRequired: boolean
  onDone: (user: AuthUser) => void
  onSkip: () => void
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [token, setToken] = useState('')
  const [registerEnabled, setRegisterEnabled] = useState(true)
  const [guestEnabled, setGuestEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    setError('')
    if (username.trim().length < 3) return setError('用户名至少 3 个字符。')
    if (password.length < 8) return setError('密码至少 8 个字符。')
    if (password !== confirm) return setError('两次输入的密码不一致。')
    if (tokenRequired && token.trim() === '') return setError('请输入服务器启动日志里的初始化令牌。')
    setBusy(true)
    try {
      const user = await installInstance({
        token: token.trim() || undefined,
        username: username.trim(),
        password,
        guestEnabled,
        registerEnabled
      })
      onDone(user)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="mb-4 flex items-center gap-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <ShieldCheck size={18} />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-medium">首次使用，先完成初始化</h2>
          <p className="text-xs text-ink-muted">创建管理员账号，设定谁能进入这个实例。</p>
        </div>
      </div>

      <form className="grid gap-3" onSubmit={submit}>
        <Field label="管理员用户名">
          <TextInput
            className="h-10 px-3"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
            placeholder="3-64 位：字母、数字、. _ - @"
            autoFocus
          />
        </Field>
        <Field label="密码">
          <TextInput
            className="h-10 px-3"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            placeholder="至少 8 位"
          />
        </Field>
        <Field label="确认密码">
          <TextInput
            className="h-10 px-3"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.currentTarget.value)}
            placeholder="再输一遍"
          />
        </Field>

        {tokenRequired && (
          <Field label="初始化令牌" hint="在服务器启动日志里,形如 XXXXXXXX-XXXXXXXX-…">
            <TextInput
              className="h-10 px-3 font-mono text-xs tracking-wide"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.currentTarget.value)}
              placeholder="从启动日志复制"
            />
          </Field>
        )}

        <div className="grid gap-2">
          <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2.5">
            <div className="min-w-0 pr-3">
              <p className="text-[13px]">开放账号注册</p>
              <p className="text-xs text-ink-muted">允许其他人用用户名密码自行注册。</p>
            </div>
            <Switch checked={registerEnabled} onChange={setRegisterEnabled} />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2.5">
            <div className="min-w-0 pr-3">
              <p className="text-[13px]">开启游客模式</p>
              <p className="text-xs text-ink-muted">访客免注册直接使用，约 24 小时后清理。公网建议关闭。</p>
            </div>
            <Switch checked={guestEnabled} onChange={setGuestEnabled} />
          </div>
        </div>

        {error && <p className="text-[13px] text-accent">{error}</p>}

        <Button type="submit" variant="primary" className="mt-1 h-10 justify-center" aria-disabled={busy}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
          创建管理员并进入
        </Button>

        <p className="text-center text-[12px] leading-relaxed text-ink-muted">
          AI 抠图、邮箱登录、第三方登录等可选服务，初始化后在管理员后台随时配置。
        </p>
      </form>

      <button
        type="button"
        onClick={onSkip}
        className="mt-3 w-full text-center text-[12px] text-ink-muted transition-colors hover:text-ink"
      >
        跳过，直接登录 / 注册
      </button>
    </>
  )
}
