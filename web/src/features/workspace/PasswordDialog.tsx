import { useEffect, useState } from 'react'
import { KeyRound } from 'lucide-react'
import { Button } from '../../ui/Button'
import { Dialog, DialogContent } from '../../ui/Dialog'
import { Field, TextInput } from '../../ui/Field'
import { usePasswordPrompt } from './passwordPrompt'

/** 加密 PDF 的按需密码弹层（替代常驻密码输入框）。 */
export function PasswordDialog() {
  const pending = usePasswordPrompt((state) => state.pending)
  const answer = usePasswordPrompt((state) => state.answer)
  const [password, setPassword] = useState('')

  useEffect(() => {
    if (pending) setPassword('')
  }, [pending])

  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && answer(null)}>
      {pending && (
        <DialogContent title="需要打开密码" className="w-[380px] max-w-[92vw]">
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              answer(password)
            }}
          >
            <p className="flex items-start gap-2 text-[13px] leading-relaxed text-ink-muted">
              <KeyRound size={16} className="mt-0.5 shrink-0 text-accent" />
              <span>
                <span className="break-all font-medium text-ink">{pending.fileName}</span> 受密码保护
                {pending.retry && <span className="text-accent">，刚才输入的密码不正确</span>}。
              </span>
            </p>
            <Field label="打开密码">
              <TextInput
                type="password"
                value={password}
                autoFocus
                autoComplete="off"
                onChange={(event) => setPassword(event.currentTarget.value)}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" onClick={() => answer(null)}>
                跳过该文件
              </Button>
              <Button type="submit" variant="primary" disabled={password === ''}>
                解锁导入
              </Button>
            </div>
          </form>
        </DialogContent>
      )}
    </Dialog>
  )
}
