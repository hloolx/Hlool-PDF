import { useState } from 'react'
import { Loader2, Mail } from 'lucide-react'
import { errorText, postJSON } from '../../lib/api'
import type { AuthUser } from '../../lib/types'
import { toast } from '../../state/toasts'
import { Button } from '../../ui/Button'
import { Field, TextInput } from '../../ui/Field'

export function EmailLogin({ onSuccess }: { onSuccess: (user: AuthUser) => void }) {
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [expiresIn, setExpiresIn] = useState(600)

  async function sendCode(e: React.FormEvent) {
    e.preventDefault()
    if (loading) return
    setLoading(true)
    try {
      const data = await postJSON<{ expiresIn?: number }>('/auth/email/send-code', { email: email.trim() })
      setExpiresIn(data.expiresIn ?? 600)
      setCode('')
      setStep('code')
      toast('验证码已发送，请查收邮件', { kind: 'success' })
    } catch (err) {
      toast(errorText(err), { kind: 'error' })
    } finally {
      setLoading(false)
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault()
    if (loading) return
    setLoading(true)
    try {
      const user = await postJSON<AuthUser>('/auth/email/verify', { email: email.trim(), code: code.trim() })
      toast('登录成功', { kind: 'success' })
      onSuccess(user)
    } catch (err) {
      toast(errorText(err), { kind: 'error' })
    } finally {
      setLoading(false)
    }
  }

  if (step === 'code') {
    return (
      <form onSubmit={verify} className="grid gap-4">
        <div className="text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-accent-soft">
            <Mail className="text-accent" size={24} />
          </div>
          <p className="text-sm text-ink-muted">
            验证码已发送至 <strong>{email}</strong>
          </p>
          <p className="mt-1 text-xs text-ink-muted">{Math.round(expiresIn / 60)} 分钟内有效</p>
        </div>

        <Field label="验证码">
          <TextInput
            value={code}
            onChange={(e) => setCode(e.currentTarget.value)}
            placeholder="6 位数字"
            maxLength={6}
            autoFocus
          />
        </Field>

        <Button type="submit" variant="primary" disabled={loading || code.trim().length !== 6}>
          {loading ? <Loader2 size={16} className="animate-spin" /> : null}
          验证并登录
        </Button>

        <Button type="button" variant="ghost" onClick={() => setStep('email')}>
          使用其他邮箱
        </Button>
      </form>
    )
  }

  return (
    <form onSubmit={sendCode} className="grid gap-4">
      <Field label="邮箱">
        <TextInput
          type="email"
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
          placeholder="your@email.com"
          autoFocus
        />
      </Field>

      <Button type="submit" variant="primary" disabled={loading || email.trim() === ''}>
        {loading ? <Loader2 size={16} className="animate-spin" /> : <Mail size={16} />}
        发送验证码
      </Button>
    </form>
  )
}
