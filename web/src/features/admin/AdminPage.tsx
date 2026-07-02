import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Copy, Loader2, Save, ShieldCheck, TicketPlus, Trash2 } from 'lucide-react'
import { errorText } from '../../lib/api'
import { cx } from '../../lib/cx'
import { Button, ConfirmButton } from '../../ui/Button'
import { Field, NumberField, TextInput } from '../../ui/Field'
import { Switch } from '../../ui/Switch'
import { ToastHost } from '../../ui/ToastHost'
import { toast } from '../../state/toasts'
import {
  createInvites,
  deleteInvite,
  getAdminSettings,
  listInvites,
  saveAdminSettings,
  setInviteDisabled,
  type AdminSettings,
  type RegistrationInvite
} from './api'
import { ProvidersPanel } from './ProvidersPanel'

const fallbackSettings: AdminSettings = {
  registerEnabled: true,
  inviteRequired: false,
  thirdPartyRegisterEnabled: true,
  guestEnabled: false
}

export function AdminPage() {
  const [settings, setSettings] = useState<AdminSettings>(fallbackSettings)
  const [invites, setInvites] = useState<RegistrationInvite[]>([])
  const [created, setCreated] = useState<RegistrationInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: '新用户邀请', count: 1, maxUses: 1, expiresInDays: 30 })

  async function reload() {
    setLoading(true)
    try {
      const [nextSettings, nextInvites] = await Promise.all([getAdminSettings(), listInvites()])
      setSettings(nextSettings)
      setInvites(nextInvites)
    } catch (err) {
      toast(`加载后台配置失败：${errorText(err)}`, { kind: 'error' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  async function saveSettings() {
    setSaving(true)
    try {
      const next = await saveAdminSettings(settings)
      setSettings(next)
      toast('后台开关已保存', { kind: 'success' })
    } catch (err) {
      toast(`保存失败：${errorText(err)}`, { kind: 'error' })
    } finally {
      setSaving(false)
    }
  }

  async function submitInvites(event: React.FormEvent) {
    event.preventDefault()
    setCreating(true)
    try {
      const next = await createInvites(form)
      setCreated(next)
      setInvites((current) => [...next, ...current])
      toast(`已生成 ${next.length} 个邀请码`, { kind: 'success' })
    } catch (err) {
      toast(`生成失败：${errorText(err)}`, { kind: 'error' })
    } finally {
      setCreating(false)
    }
  }

  async function toggleInvite(invite: RegistrationInvite) {
    try {
      await setInviteDisabled(invite.id, !invite.disabled)
      setInvites((items) => items.map((item) => (item.id === invite.id ? { ...item, disabled: !invite.disabled } : item)))
      void reload()
    } catch (err) {
      toast(`更新邀请码失败：${errorText(err)}`, { kind: 'error' })
    }
  }

  async function removeInvite(invite: RegistrationInvite) {
    try {
      await deleteInvite(invite.id)
      setInvites((items) => items.filter((item) => item.id !== invite.id))
      toast('邀请码已删除', { kind: 'success' })
    } catch (err) {
      toast(`删除失败：${errorText(err)}`, { kind: 'error' })
    }
  }

  const createdCodes = useMemo(() => created.map((item) => item.code).filter(Boolean) as string[], [created])

  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <Button variant="ghost" onClick={() => (window.location.href = '/')}>
          <ArrowLeft size={16} />
          返回工作区
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <ShieldCheck size={18} />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-semibold">管理员后台</h1>
            <p className="truncate text-xs text-ink-muted">注册策略与邀请码</p>
          </div>
        </div>
        <div className="flex-1" />
        <Button variant="primary" disabled={saving || loading} onClick={() => void saveSettings()}>
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          保存开关
        </Button>
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-4 py-4">
        <div className="mx-auto grid max-w-6xl gap-4">
          <ProvidersPanel />

          <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <section className="h-fit rounded-lg border border-line bg-panel">
            <div className="border-b border-line px-4 py-3">
              <h2 className="text-[13px] font-semibold">访问开关</h2>
              <p className="mt-0.5 text-xs text-ink-muted">开关保存后立即影响注册和游客入口。</p>
            </div>
            <div className="grid gap-0">
              <SettingSwitch
                title="开放账号注册"
                hint="关闭后，新用户不能通过用户名密码创建账号。"
                checked={settings.registerEnabled}
                onChange={(registerEnabled) => setSettings((value) => ({ ...value, registerEnabled }))}
              />
              <SettingSwitch
                title="注册需要邀请码"
                hint="开启后，注册表单会要求填写管理员生成的邀请码。"
                checked={settings.inviteRequired}
                disabled={!settings.registerEnabled}
                onChange={(inviteRequired) => setSettings((value) => ({ ...value, inviteRequired }))}
              />
              <SettingSwitch
                title="允许第三方注册"
                hint="控制外部身份首次自动开号；已有绑定账号登录不受影响。"
                checked={settings.thirdPartyRegisterEnabled}
                onChange={(thirdPartyRegisterEnabled) => setSettings((value) => ({ ...value, thirdPartyRegisterEnabled }))}
              />
              <SettingSwitch
                title="开启游客"
                hint="游客身份约 24 小时后连同印章库一起清理。公网实例建议关闭。"
                checked={settings.guestEnabled}
                onChange={(guestEnabled) => setSettings((value) => ({ ...value, guestEnabled }))}
              />
            </div>
          </section>

          <section className="min-w-0 rounded-lg border border-line bg-panel">
            <div className="flex flex-col gap-2 border-b border-line px-4 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <h2 className="text-[13px] font-semibold">邀请码</h2>
                <p className="mt-0.5 text-xs text-ink-muted">明文只在创建后展示，列表保留尾号、用量和状态。</p>
              </div>
              <Button disabled={loading} onClick={() => void reload()}>
                {loading ? <Loader2 size={16} className="animate-spin" /> : null}
                刷新
              </Button>
            </div>

            <div className="grid gap-4 p-4">
              <form className="grid gap-3 rounded-lg bg-sunken p-3 sm:grid-cols-[minmax(180px,1fr)] md:grid-cols-[minmax(180px,1fr)_120px_120px_140px_auto]" onSubmit={submitInvites}>
                <Field label="批次名称">
                  <TextInput value={form.name} onChange={(event) => setForm((value) => ({ ...value, name: event.currentTarget.value }))} />
                </Field>
                <Field label="数量">
                  <NumberField min={1} max={100} value={form.count} onChange={(count) => setForm((value) => ({ ...value, count: Math.round(count) }))} />
                </Field>
                <Field label="可用次数">
                  <NumberField min={1} max={1000} value={form.maxUses} onChange={(maxUses) => setForm((value) => ({ ...value, maxUses: Math.round(maxUses) }))} />
                </Field>
                <Field label="有效期">
                  <NumberField
                    min={0}
                    max={3650}
                    value={form.expiresInDays}
                    unit="天"
                    onChange={(expiresInDays) => setForm((value) => ({ ...value, expiresInDays: Math.round(expiresInDays) }))}
                  />
                </Field>
                <div className="flex items-end sm:col-span-full md:col-span-1">
                  <Button type="submit" variant="primary" className="w-full" disabled={creating}>
                    {creating ? <Loader2 size={16} className="animate-spin" /> : <TicketPlus size={16} />}
                    生成
                  </Button>
                </div>
              </form>

              {createdCodes.length > 0 && (
                <div className="rounded-lg border border-accent/25 bg-accent-soft/70 p-3">
                  <div className="flex items-center gap-2">
                    <p className="flex-1 text-[13px] font-medium text-ink">本次生成的邀请码</p>
                    <Button size="sm" onClick={() => void copyText(createdCodes.join('\n'))}>
                      <Copy size={15} />
                      复制全部
                    </Button>
                  </div>
                  <div className="mt-2 grid gap-1.5">
                    {createdCodes.map((code) => (
                      <button
                        key={code}
                        type="button"
                        className="min-w-0 rounded-md bg-panel px-2.5 py-1.5 text-left font-mono text-xs tracking-wide text-ink transition hover:bg-white"
                        onClick={() => void copyText(code)}
                      >
                        {code}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <InviteTable invites={invites} onToggle={toggleInvite} onDelete={removeInvite} />
            </div>
          </section>
          </div>
        </div>
      </main>

      <div className="fixed bottom-4 right-4 z-[60]">
        <ToastHost />
      </div>
    </div>
  )
}

function SettingSwitch({
  title,
  hint,
  checked,
  disabled,
  onChange
}: {
  title: string
  hint: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start gap-3 border-b border-line/70 px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className={cx('text-[13px] font-medium', disabled && 'text-ink-muted')}>{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{hint}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  )
}

function InviteTable({
  invites,
  onToggle,
  onDelete
}: {
  invites: RegistrationInvite[]
  onToggle: (invite: RegistrationInvite) => void
  onDelete: (invite: RegistrationInvite) => void
}) {
  if (invites.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line bg-panel px-4 py-8 text-center text-sm text-ink-muted">
        还没有邀请码。
      </div>
    )
  }
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="max-h-[520px] overflow-auto">
        <table className="w-full min-w-[680px] border-collapse text-left text-[13px]">
          <thead className="sticky top-0 bg-sunken text-xs text-ink-muted">
            <tr>
              <th className="px-3 py-2 font-medium">批次</th>
              <th className="hidden px-3 py-2 font-medium sm:table-cell">尾号</th>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="hidden px-3 py-2 font-medium md:table-cell">用量</th>
              <th className="hidden px-3 py-2 font-medium lg:table-cell">有效期</th>
              <th className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {invites.map((invite) => (
              <tr key={invite.id} className="border-t border-line/70">
                <td className="max-w-[220px] truncate px-3 py-2" title={invite.name}>
                  {invite.name}
                </td>
                <td className="hidden px-3 py-2 font-mono text-xs tracking-wide sm:table-cell">•••• {invite.codeHint}</td>
                <td className="px-3 py-2">
                  <StatusPill status={invite.status} disabled={invite.disabled} />
                </td>
                <td className="tnum hidden px-3 py-2 md:table-cell">
                  {invite.usedCount} / {invite.maxUses}
                </td>
                <td className="tnum hidden px-3 py-2 text-ink-muted lg:table-cell">{invite.expiresAt ? formatDate(invite.expiresAt) : '长期'}</td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => void onToggle(invite)}>
                      {invite.disabled ? '启用' : '禁用'}
                    </Button>
                    <ConfirmButton title="删除邀请码" confirmLabel="再点一次删除" onConfirm={() => onDelete(invite)}>
                      <Trash2 size={15} />
                    </ConfirmButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function StatusPill({ status, disabled }: { status: RegistrationInvite['status']; disabled: boolean }) {
  const label = disabled
    ? '已禁用'
    : status === 'active'
      ? '可用'
      : status === 'used'
        ? '已用完'
        : status === 'expired'
          ? '已过期'
          : '已禁用'
  return (
    <span
      className={cx(
        'inline-flex h-6 items-center rounded-full px-2 text-xs',
        status === 'active' && !disabled ? 'bg-accent-soft text-accent' : 'bg-sunken text-ink-muted'
      )}
    >
      {label}
    </span>
  )
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(
    new Date(value)
  )
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    toast('已复制', { kind: 'success' })
  } catch {
    toast('复制失败，请手动选择文本', { kind: 'error' })
  }
}
