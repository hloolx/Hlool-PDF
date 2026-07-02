import { useEffect, useState } from 'react'
import { ArrowLeft, Loader2, LogIn, UserPlus } from 'lucide-react'
import { errorText } from '../../lib/api'
import type { AuthConfig } from '../../lib/types'
import { Button } from '../../ui/Button'
import { Field, TextInput } from '../../ui/Field'
import { Segmented } from '../../ui/Segmented'
import { bootWorkspace } from '../workspace/boot'
import { InstallWizard } from '../install/InstallWizard'
import { fetchAuthConfig, login, register } from './api'
import { useAuth } from './useAuth'
import { EmailLogin } from './EmailLogin'
import { OAuthButtons } from './OAuthButtons'

type Mode = 'login' | 'register' | 'email'

export function AuthScreen() {
  // 已登录（临时身份）主动打开时，可返回工作区；并默认停在“注册”页引导建号。
  const canDismiss = useAuth((s) => s.status === 'authed')
  const setPromptLogin = useAuth((s) => s.setPromptLogin)
  const setAuthed = useAuth((s) => s.setAuthed)
  const [mode, setMode] = useState<Mode>(() => (useAuth.getState().status === 'authed' ? 'register' : 'login'))
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // 实例未初始化时优先展示安装向导;「跳过」只对本次会话生效。
  const [skipInstall, setSkipInstall] = useState(false)

  useEffect(() => {
    let alive = true
    fetchAuthConfig()
      .then((next) => {
        if (!alive) return
        setConfig(next)
        if (!next.registerEnabled) setMode('login')
      })
      .catch(() => {
        if (alive) setConfig({ registerEnabled: true, inviteRequired: false, thirdPartyRegisterEnabled: true, guestEnabled: false })
      })
    return () => {
      alive = false
    }
  }, [])

  const emailOn = config?.emailLoginEnabled === true
  const oauthProviders = config?.oauthProviders ?? []
  const hasAltLogin = emailOn || oauthProviders.length > 0
  const showInstall = config?.needsInstall === true && !skipInstall

  // 配置加载后发现邮箱登录未开启而当前停在邮箱页：退回密码登录。
  useEffect(() => {
    if (config && config.emailLoginEnabled !== true && mode === 'email') setMode('login')
  }, [config, mode])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    setError('')
    const user = username.trim()
    if (user.length < 3) return setError('用户名至少 3 个字符。')
    if (password.length < 8) return setError('密码至少 8 个字符。')
    if (mode === 'register' && config?.inviteRequired && inviteCode.trim() === '') return setError('请输入邀请码。')
    setBusy(true)
    try {
      if (mode === 'register') {
        // 持有临时身份时，注册会就地升级该身份（印章/设置随 uid 保留）。
        await register(user, password, inviteCode.trim())
      }
      const authed = await login(user, password)
      setAuthed(authed)
      void bootWorkspace()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    // 安全居中:内容高于视口(手机横屏)时自动贴顶并可滚动,items-center 会把顶部裁到不可达。
    <div className="flex h-full justify-center overflow-y-auto bg-canvas px-4">
      <div className="my-auto w-full max-w-[360px] py-8">
        <div className="mb-6 flex flex-col items-center gap-2.5">
          <span className="anim-stamp-press relative flex size-12 -rotate-3 items-center justify-center rounded-2xl bg-accent text-lg font-bold text-white shadow-pop">
            印
            <span className="pointer-events-none absolute inset-[4px] rounded-xl border border-white/40" aria-hidden />
          </span>
          <h1 className="text-lg font-semibold tracking-wide">hlool pdf</h1>
          <p className="text-[13px] text-ink-muted">在线 PDF 盖章 · 阅后即焚</p>
        </div>

        <div className="rounded-2xl border border-line bg-panel p-5 shadow-pop">
          {showInstall ? (
            <InstallWizard
              tokenRequired={config?.installTokenRequired === true}
              onDone={(user) => {
                setAuthed(user)
                void bootWorkspace()
              }}
              onSkip={() => setSkipInstall(true)}
            />
          ) : mode === 'email' ? (
            <>
              <div className="mb-4 flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => setMode('login')}>
                  <ArrowLeft size={16} />
                </Button>
                <h2 className="text-sm font-medium">邮箱验证码登录</h2>
              </div>
              <EmailLogin
                onSuccess={(user) => {
                  setAuthed(user)
                  void bootWorkspace()
                }}
              />
            </>
          ) : (
            <>
              <Segmented
                className="mb-4"
                value={mode}
                onChange={(m) => {
                  setMode(m)
                  setError('')
                }}
                options={[
                  { value: 'login', label: '登录' },
                  { value: 'register', label: '注册', disabled: config?.registerEnabled === false }
                ]}
              />

              <form className="grid gap-3" onSubmit={submit}>
            <Field label="用户名">
              <TextInput
                className="h-10 px-3"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.currentTarget.value)}
                placeholder="3-64 位：字母、数字、. _ - @"
              />
            </Field>
            <Field label="密码">
              <TextInput
                className="h-10 px-3"
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
                placeholder="至少 8 位"
              />
            </Field>
            {mode === 'register' && config?.inviteRequired && (
              <Field label="邀请码">
                <TextInput
                  className="h-10 px-3 font-mono text-xs tracking-wide"
                  autoComplete="off"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.currentTarget.value)}
                  placeholder="REG-XXXX-XXXX-XXXX-XXXX"
                />
              </Field>
            )}

            {error && <p className="text-[13px] text-accent">{error}</p>}

            {mode === 'register' && config?.registerEnabled === false && (
              <p className="rounded-lg bg-sunken px-3 py-2 text-[12px] leading-relaxed text-ink-muted">
                当前实例未开放注册，请使用已有账号登录。
              </p>
            )}

            {canDismiss && mode === 'register' && (
              <p className="rounded-lg bg-sunken px-3 py-2 text-[12px] leading-relaxed text-ink-muted">
                注册后，当前临时身份里的印章和设置会自动保留到新账号。
              </p>
            )}

            <Button type="submit" variant="primary" className="mt-1 h-10 justify-center" aria-disabled={busy}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : mode === 'login' ? <LogIn size={16} /> : <UserPlus size={16} />}
              {mode === 'login' ? '登录' : '注册并登录'}
            </Button>
          </form>

          {hasAltLogin && (
            <>
              <div className="my-4 flex items-center gap-2">
                <div className="h-px flex-1 bg-line" />
                <span className="text-xs text-ink-muted">或</span>
                <div className="h-px flex-1 bg-line" />
              </div>

              <div className="grid gap-2">
                {emailOn && (
                  <Button variant="ghost" onClick={() => setMode('email')}>
                    邮箱验证码登录
                  </Button>
                )}
                <OAuthButtons providers={oauthProviders} />
              </div>
            </>
          )}
        </>
      )}
    </div>

        {canDismiss && (
          <button
            type="button"
            onClick={() => setPromptLogin(false)}
            className="mt-3 flex w-full items-center justify-center gap-1.5 text-[12px] text-ink-muted transition-colors hover:text-ink"
          >
            <ArrowLeft size={14} />
            继续以临时身份使用
          </button>
        )}

        <p className="mt-4 text-center text-[11px] leading-relaxed text-ink-muted">
          PDF 仅在处理期间临时驻留服务器，完成即删除。
          <br />
          临时身份的印章与设置约 24 小时后清除，注册可长期保存。
        </p>
      </div>
    </div>
  )
}
