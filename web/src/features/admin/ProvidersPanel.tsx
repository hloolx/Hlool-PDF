import { useState, useEffect } from 'react'
import { Sparkles, Plus, Trash2, Loader2, CheckCircle2, XCircle, Mail, KeyRound } from 'lucide-react'
import { Button, ConfirmButton } from '../../ui/Button'
import { Field, TextInput, NumberField } from '../../ui/Field'
import { Switch } from '../../ui/Switch'
import { toast } from '../../state/toasts'
import { errorText } from '../../lib/api'
import {
  getProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  testProvider,
  type Provider
} from './providers-api'

/** 内置 OAuth 提供方;数据库里 provider.name 必须等于 kind,后端按 name 匹配。 */
const OAUTH_KINDS: Array<{ kind: string; label: string }> = [
  { kind: 'github', label: 'GitHub' },
  { kind: 'google', label: 'Google' },
  { kind: 'linuxdo', label: 'LinuxDo' }
]

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function ProvidersPanel() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<string | null>(null)

  async function reload() {
    setLoading(true)
    try {
      const list = await getProviders()
      setProviders(list)
    } catch (err) {
      toast(`加载服务配置失败：${errorText(err)}`, { kind: 'error' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  async function save(id: string, data: Partial<Provider>) {
    try {
      await updateProvider(id, data)
      await reload()
      setEditing(null)
      toast('配置已保存', { kind: 'success' })
    } catch (err) {
      toast(`保存失败：${errorText(err)}`, { kind: 'error' })
    }
  }

  async function add(data: Partial<Provider>) {
    try {
      await createProvider(data)
      await reload()
      setEditing(null)
      toast('服务已添加', { kind: 'success' })
    } catch (err) {
      toast(`创建失败：${errorText(err)}`, { kind: 'error' })
    }
  }

  async function remove(id: string) {
    try {
      await deleteProvider(id)
      await reload()
      toast('服务已删除', { kind: 'success' })
    } catch (err) {
      toast(`删除失败：${errorText(err)}`, { kind: 'error' })
    }
  }

  const mattingProviders = providers.filter((p) => p.kind === 'matting')
  const mailProvider = providers.find((p) => p.kind === 'mail') ?? null
  const oauthProviders = providers.filter((p) => p.kind === 'oauth')

  return (
    <section className="rounded-lg border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="text-[13px] font-semibold">第三方服务</h2>
          <p className="mt-0.5 text-xs text-ink-muted">AI 背景移除、邮件登录、第三方登录的外部服务配置。</p>
        </div>
        <Button size="sm" onClick={() => void reload()} disabled={loading}>
          {loading ? <Loader2 size={14} className="animate-spin" /> : null}
          刷新
        </Button>
      </div>

      {/* ---------- AI 背景移除 ---------- */}
      <div className="border-b border-line p-4">
        <div className="mb-3 flex items-center gap-2">
          <Sparkles size={16} className="text-accent" />
          <h3 className="text-sm font-medium">AI 背景移除</h3>
        </div>

        {mattingProviders.length === 0 && editing !== 'new-matting' ? (
          <EmptyHint text="还没有配置 AI 背景移除服务" actionLabel="配置 Gitee AI" onAction={() => setEditing('new-matting')} />
        ) : (
          <div className="grid gap-3">
            {mattingProviders.map((provider) => (
              <MattingCard
                key={provider.id}
                provider={provider}
                editing={editing === provider.id}
                onEdit={() => setEditing(provider.id)}
                onSave={(data) => save(provider.id, data)}
                onCancel={() => setEditing(null)}
                onDelete={() => remove(provider.id)}
              />
            ))}
          </div>
        )}

        {editing === 'new-matting' && <NewMattingForm onSave={add} onCancel={() => setEditing(null)} />}
      </div>

      {/* ---------- 邮件服务(SMTP) ---------- */}
      <div className="border-b border-line p-4">
        <div className="mb-1 flex items-center gap-2">
          <Mail size={16} className="text-accent" />
          <h3 className="text-sm font-medium">邮件服务（SMTP）</h3>
        </div>
        <p className="mb-3 text-xs text-ink-muted">配置后登录页会出现「邮箱验证码登录」入口。</p>

        {!mailProvider && editing !== 'new-mail' ? (
          <EmptyHint text="还没有配置 SMTP 邮件服务" actionLabel="配置 SMTP" onAction={() => setEditing('new-mail')} />
        ) : mailProvider ? (
          <MailCard
            provider={mailProvider}
            editing={editing === mailProvider.id}
            onEdit={() => setEditing(mailProvider.id)}
            onSave={(data) => save(mailProvider.id, data)}
            onCancel={() => setEditing(null)}
            onDelete={() => remove(mailProvider.id)}
          />
        ) : null}

        {editing === 'new-mail' && <MailForm onSubmit={add} onCancel={() => setEditing(null)} />}
      </div>

      {/* ---------- 第三方登录(OAuth) ---------- */}
      <div className="p-4">
        <div className="mb-1 flex items-center gap-2">
          <KeyRound size={16} className="text-accent" />
          <h3 className="text-sm font-medium">第三方登录（OAuth）</h3>
        </div>
        <p className="mb-3 text-xs text-ink-muted">配置后登录页会出现对应的第三方登录按钮。</p>

        <div className="grid gap-3">
          {OAUTH_KINDS.map(({ kind, label }) => {
            const provider = oauthProviders.find((p) => p.name.toLowerCase() === kind) ?? null
            if (!provider) {
              return (
                <div key={kind}>
                  {editing === `new-oauth-${kind}` ? (
                    <OAuthForm kind={kind} label={label} onSubmit={add} onCancel={() => setEditing(null)} />
                  ) : (
                    <div className="flex items-center justify-between rounded-lg border border-dashed border-line bg-sunken px-3 py-2.5">
                      <span className="text-sm text-ink-muted">{label} 登录未配置</span>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(`new-oauth-${kind}`)}>
                        <Plus size={14} />
                        配置
                      </Button>
                    </div>
                  )}
                </div>
              )
            }
            return (
              <OAuthCard
                key={kind}
                label={label}
                kind={kind}
                provider={provider}
                editing={editing === provider.id}
                onEdit={() => setEditing(provider.id)}
                onSave={(data) => save(provider.id, data)}
                onCancel={() => setEditing(null)}
                onDelete={() => remove(provider.id)}
              />
            )
          })}
        </div>
      </div>
    </section>
  )
}

/* ================= 通用小件 ================= */

function EmptyHint({ text, actionLabel, onAction }: { text: string; actionLabel: string; onAction: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-sunken p-6 text-center">
      <p className="text-sm text-ink-muted">{text}</p>
      <Button size="sm" className="mt-3" onClick={onAction}>
        <Plus size={14} />
        {actionLabel}
      </Button>
    </div>
  )
}

function StatusChip({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">已启用</span>
  ) : (
    <span className="rounded-full bg-sunken px-2 py-0.5 text-xs text-ink-muted">已禁用</span>
  )
}

function TestResultLine({ result }: { result: { success: boolean; error?: string } | null }) {
  if (!result) return null
  return (
    <div className="mt-2 flex items-center gap-1.5">
      {result.success ? (
        <>
          <CheckCircle2 size={14} className="text-accent" />
          <span className="text-xs text-accent">连接正常</span>
        </>
      ) : (
        <>
          <XCircle size={14} className="text-danger" />
          <span className="text-xs text-danger">{result.error}</span>
        </>
      )}
    </div>
  )
}

function useTest(id: string) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ success: boolean; error?: string } | null>(null)
  async function run() {
    setTesting(true)
    setResult(null)
    try {
      const outcome = await testProvider(id)
      setResult(outcome)
      if (outcome.success) toast('连接测试成功', { kind: 'success' })
      else toast(`测试失败：${outcome.error}`, { kind: 'error' })
    } catch (err) {
      setResult({ success: false, error: errorText(err) })
    } finally {
      setTesting(false)
    }
  }
  return { testing, result, run }
}

function CardActions({
  onTest,
  testing,
  onEdit,
  onDelete
}: {
  onTest?: () => void
  testing?: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className="flex gap-1">
      {onTest && (
        <Button size="sm" variant="ghost" onClick={onTest} disabled={testing}>
          {testing ? <Loader2 size={14} className="animate-spin" /> : '测试'}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={onEdit}>
        编辑
      </Button>
      <ConfirmButton size="sm" confirmLabel="确认删除" onConfirm={onDelete}>
        <Trash2 size={14} />
      </ConfirmButton>
    </div>
  )
}

/* ================= AI 背景移除 ================= */

function MattingCard({
  provider,
  editing,
  onEdit,
  onSave,
  onCancel,
  onDelete
}: {
  provider: Provider
  editing: boolean
  onEdit: () => void
  onSave: (data: Partial<Provider>) => void
  onCancel: () => void
  onDelete: () => void
}) {
  const [form, setForm] = useState({
    enabled: provider.enabled,
    baseURL: provider.baseURL || 'https://ai.gitee.com/v1',
    model: provider.model || 'RMBG-2.0',
    accessToken: ''
  })
  const { testing, result, run } = useTest(provider.id)

  if (editing) {
    return (
      <div className="rounded-lg border border-accent/30 bg-panel p-4">
        <div className="grid gap-3">
          <div className="flex items-center gap-2">
            <Switch checked={form.enabled} onChange={(enabled) => setForm((f) => ({ ...f, enabled }))} />
            <span className="text-sm font-medium">{form.enabled ? '启用' : '禁用'}</span>
          </div>
          <Field label="API 地址">
            <TextInput value={form.baseURL} onChange={(e) => setForm((f) => ({ ...f, baseURL: e.currentTarget.value }))} />
          </Field>
          <Field label="模型">
            <TextInput value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.currentTarget.value }))} placeholder="RMBG-2.0" />
          </Field>
          <Field label="Access Token" hint="留空保留现有密钥">
            <TextInput
              type="password"
              value={form.accessToken}
              onChange={(e) => setForm((f) => ({ ...f, accessToken: e.currentTarget.value }))}
              placeholder="留空不修改"
            />
          </Field>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onCancel}>
              取消
            </Button>
            <Button
              onClick={() =>
                onSave({
                  enabled: form.enabled,
                  baseURL: form.baseURL,
                  model: form.model,
                  secretConfig: form.accessToken ? { access_token: form.accessToken } : undefined
                })
              }
            >
              保存
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-line bg-sunken p-3">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{provider.name}</span>
            <StatusChip enabled={provider.enabled} />
          </div>
          <p className="mt-1 text-xs text-ink-muted">模型: {provider.model || 'RMBG-2.0'}</p>
          <TestResultLine result={result} />
        </div>
        <CardActions onTest={() => void run()} testing={testing} onEdit={onEdit} onDelete={onDelete} />
      </div>
    </div>
  )
}

function NewMattingForm({ onSave, onCancel }: { onSave: (data: Partial<Provider>) => void; onCancel: () => void }) {
  const [form, setForm] = useState({
    name: 'Gitee AI 背景移除',
    baseURL: 'https://ai.gitee.com/v1',
    model: 'RMBG-2.0',
    accessToken: ''
  })

  return (
    <div className="mt-3 rounded-lg border border-accent/30 bg-panel p-4">
      <h4 className="mb-3 text-sm font-medium">新增 Gitee AI 配置</h4>
      <div className="grid gap-3">
        <Field label="服务名称">
          <TextInput value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.currentTarget.value }))} />
        </Field>
        <Field label="API 地址">
          <TextInput value={form.baseURL} onChange={(e) => setForm((f) => ({ ...f, baseURL: e.currentTarget.value }))} />
        </Field>
        <Field label="模型">
          <TextInput value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.currentTarget.value }))} />
        </Field>
        <Field label="Access Token" hint="从 Gitee AI 控制台获取">
          <TextInput
            type="password"
            value={form.accessToken}
            onChange={(e) => setForm((f) => ({ ...f, accessToken: e.currentTarget.value }))}
            placeholder="输入 Access Token"
          />
        </Field>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button
            onClick={() =>
              onSave({
                kind: 'matting',
                name: form.name,
                enabled: true,
                baseURL: form.baseURL,
                model: form.model,
                publicConfig: {},
                secretConfig: { access_token: form.accessToken }
              })
            }
            disabled={!form.accessToken}
          >
            <Plus size={14} />
            添加
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ================= 邮件服务(SMTP) ================= */

type MailFormState = {
  enabled: boolean
  host: string
  port: number
  useTLS: boolean
  from: string
  username: string
  password: string
}

function mailFormFrom(provider: Provider | null): MailFormState {
  return {
    enabled: provider?.enabled ?? true,
    host: str(provider?.publicConfig?.host),
    port: num(provider?.publicConfig?.port, 465),
    useTLS: provider?.publicConfig?.use_tls !== false,
    from: str(provider?.publicConfig?.from),
    username: '',
    password: ''
  }
}

/** 组装保存载荷。账号与密码同属加密配置,必须成对提交,否则会互相覆盖丢失。 */
function mailPayload(form: MailFormState, isNew: boolean): Partial<Provider> | string {
  if (!form.host.trim()) return '请填写 SMTP 服务器地址'
  const hasUser = form.username.trim() !== ''
  const hasPass = form.password !== ''
  if (isNew && (!hasUser || !hasPass)) return '请填写发信账号与密码'
  if (!isNew && hasUser !== hasPass) return '修改凭据时,账号与密码需要一起填写'
  return {
    kind: 'mail',
    name: 'SMTP 邮件服务',
    enabled: form.enabled,
    publicConfig: {
      host: form.host.trim(),
      port: form.port,
      use_tls: form.useTLS,
      from: form.from.trim()
    },
    secretConfig: hasUser ? { username: form.username.trim(), password: form.password } : undefined
  }
}

function MailFields({ form, setForm }: { form: MailFormState; setForm: React.Dispatch<React.SetStateAction<MailFormState>> }) {
  return (
    <>
      <div className="grid grid-cols-[1fr_100px] gap-3">
        <Field label="SMTP 服务器">
          <TextInput
            value={form.host}
            onChange={(e) => setForm((f) => ({ ...f, host: e.currentTarget.value }))}
            placeholder="smtp.example.com"
          />
        </Field>
        <Field label="端口">
          <NumberField value={form.port} min={1} max={65535} step={1} onChange={(port) => setForm((f) => ({ ...f, port }))} />
        </Field>
      </div>
      <div className="flex items-center justify-between rounded-lg border border-line px-2.5 py-2">
        <div>
          <p className="text-[13px]">SSL/TLS 直连</p>
          <p className="text-xs text-ink-muted">465 端口开启；587 端口关闭（自动尝试 STARTTLS）</p>
        </div>
        <Switch
          checked={form.useTLS}
          onChange={(useTLS) => setForm((f) => ({ ...f, useTLS, port: useTLS ? 465 : 587 }))}
        />
      </div>
      <Field label="发件人地址" hint="留空时使用发信账号">
        <TextInput
          value={form.from}
          onChange={(e) => setForm((f) => ({ ...f, from: e.currentTarget.value }))}
          placeholder="noreply@example.com"
        />
      </Field>
      <Field label="发信账号">
        <TextInput
          value={form.username}
          onChange={(e) => setForm((f) => ({ ...f, username: e.currentTarget.value }))}
          placeholder="登录 SMTP 的邮箱账号"
          autoComplete="off"
        />
      </Field>
      <Field label="密码 / 授权码" hint="QQ、163 等邮箱需使用授权码而非登录密码">
        <TextInput
          type="password"
          value={form.password}
          onChange={(e) => setForm((f) => ({ ...f, password: e.currentTarget.value }))}
          placeholder="SMTP 密码或授权码"
          autoComplete="new-password"
        />
      </Field>
    </>
  )
}

function MailForm({ onSubmit, onCancel }: { onSubmit: (data: Partial<Provider>) => void; onCancel: () => void }) {
  const [form, setForm] = useState<MailFormState>(mailFormFrom(null))
  return (
    <div className="mt-3 rounded-lg border border-accent/30 bg-panel p-4">
      <h4 className="mb-3 text-sm font-medium">新增 SMTP 配置</h4>
      <div className="grid gap-3">
        <MailFields form={form} setForm={setForm} />
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button
            onClick={() => {
              const payload = mailPayload(form, true)
              if (typeof payload === 'string') toast(payload, { kind: 'error' })
              else onSubmit(payload)
            }}
          >
            <Plus size={14} />
            添加
          </Button>
        </div>
      </div>
    </div>
  )
}

function MailCard({
  provider,
  editing,
  onEdit,
  onSave,
  onCancel,
  onDelete
}: {
  provider: Provider
  editing: boolean
  onEdit: () => void
  onSave: (data: Partial<Provider>) => void
  onCancel: () => void
  onDelete: () => void
}) {
  const [form, setForm] = useState<MailFormState>(() => mailFormFrom(provider))
  const { testing, result, run } = useTest(provider.id)

  if (editing) {
    return (
      <div className="rounded-lg border border-accent/30 bg-panel p-4">
        <div className="grid gap-3">
          <div className="flex items-center gap-2">
            <Switch checked={form.enabled} onChange={(enabled) => setForm((f) => ({ ...f, enabled }))} />
            <span className="text-sm font-medium">{form.enabled ? '启用' : '禁用'}</span>
          </div>
          <MailFields form={form} setForm={setForm} />
          <p className="text-xs text-ink-muted">账号与密码留空表示保留现有凭据；修改时两项需一起填写。</p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onCancel}>
              取消
            </Button>
            <Button
              onClick={() => {
                const payload = mailPayload(form, false)
                if (typeof payload === 'string') toast(payload, { kind: 'error' })
                else onSave(payload)
              }}
            >
              保存
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-line bg-sunken p-3">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{provider.name}</span>
            <StatusChip enabled={provider.enabled} />
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            {str(provider.publicConfig?.host, '未填写服务器')}:{num(provider.publicConfig?.port, 465)}
          </p>
          <TestResultLine result={result} />
        </div>
        <CardActions onTest={() => void run()} testing={testing} onEdit={onEdit} onDelete={onDelete} />
      </div>
    </div>
  )
}

/* ================= 第三方登录(OAuth) ================= */

function callbackURL(kind: string) {
  return `${window.location.origin}/auth/oauth/${kind}/callback`
}

function OAuthFields({
  kind,
  clientID,
  clientSecret,
  onClientID,
  onClientSecret,
  isNew
}: {
  kind: string
  clientID: string
  clientSecret: string
  onClientID: (v: string) => void
  onClientSecret: (v: string) => void
  isNew: boolean
}) {
  return (
    <>
      <Field label="Client ID">
        <TextInput value={clientID} onChange={(e) => onClientID(e.currentTarget.value)} autoComplete="off" />
      </Field>
      <Field label="Client Secret" hint={isNew ? undefined : '留空保留现有密钥'}>
        <TextInput
          type="password"
          value={clientSecret}
          onChange={(e) => onClientSecret(e.currentTarget.value)}
          placeholder={isNew ? '输入 Client Secret' : '留空不修改'}
          autoComplete="new-password"
        />
      </Field>
      <Field label="回调地址" hint="填到提供方的 OAuth 应用设置里">
        <TextInput value={callbackURL(kind)} readOnly onFocus={(e) => e.currentTarget.select()} />
      </Field>
    </>
  )
}

function OAuthForm({
  kind,
  label,
  onSubmit,
  onCancel
}: {
  kind: string
  label: string
  onSubmit: (data: Partial<Provider>) => void
  onCancel: () => void
}) {
  const [clientID, setClientID] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  return (
    <div className="rounded-lg border border-accent/30 bg-panel p-4">
      <h4 className="mb-3 text-sm font-medium">配置 {label} 登录</h4>
      <div className="grid gap-3">
        <OAuthFields
          kind={kind}
          clientID={clientID}
          clientSecret={clientSecret}
          onClientID={setClientID}
          onClientSecret={setClientSecret}
          isNew
        />
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button
            onClick={() =>
              onSubmit({
                kind: 'oauth',
                name: kind,
                enabled: true,
                publicConfig: { client_id: clientID.trim() },
                secretConfig: { client_secret: clientSecret }
              })
            }
            disabled={!clientID.trim() || !clientSecret}
          >
            <Plus size={14} />
            添加
          </Button>
        </div>
      </div>
    </div>
  )
}

function OAuthCard({
  label,
  kind,
  provider,
  editing,
  onEdit,
  onSave,
  onCancel,
  onDelete
}: {
  label: string
  kind: string
  provider: Provider
  editing: boolean
  onEdit: () => void
  onSave: (data: Partial<Provider>) => void
  onCancel: () => void
  onDelete: () => void
}) {
  const [form, setForm] = useState(() => ({
    enabled: provider.enabled,
    clientID: str(provider.publicConfig?.client_id),
    clientSecret: ''
  }))

  if (editing) {
    return (
      <div className="rounded-lg border border-accent/30 bg-panel p-4">
        <div className="grid gap-3">
          <div className="flex items-center gap-2">
            <Switch checked={form.enabled} onChange={(enabled) => setForm((f) => ({ ...f, enabled }))} />
            <span className="text-sm font-medium">{form.enabled ? '启用' : '禁用'}</span>
          </div>
          <OAuthFields
            kind={kind}
            clientID={form.clientID}
            clientSecret={form.clientSecret}
            onClientID={(clientID) => setForm((f) => ({ ...f, clientID }))}
            onClientSecret={(clientSecret) => setForm((f) => ({ ...f, clientSecret }))}
            isNew={false}
          />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onCancel}>
              取消
            </Button>
            <Button
              onClick={() =>
                onSave({
                  enabled: form.enabled,
                  publicConfig: { client_id: form.clientID.trim() },
                  secretConfig: form.clientSecret ? { client_secret: form.clientSecret } : undefined
                })
              }
              disabled={!form.clientID.trim()}
            >
              保存
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-line bg-sunken p-3">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{label}</span>
            <StatusChip enabled={provider.enabled} />
          </div>
          <p className="mt-1 truncate text-xs text-ink-muted">Client ID: {str(provider.publicConfig?.client_id, '未填写')}</p>
        </div>
        <CardActions onEdit={onEdit} onDelete={onDelete} />
      </div>
    </div>
  )
}
