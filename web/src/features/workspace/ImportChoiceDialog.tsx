import type { ReactNode } from 'react'
import { FilePlus, FileStack } from 'lucide-react'
import { Dialog, DialogContent } from '../../ui/Dialog'
import { useImportPrompt, type ImportTarget } from './importPrompt'

/** 文件选择器导入后的去向选择：并入当前项目，或作为新项目打开。 */
export function ImportChoiceDialog() {
  const pending = useImportPrompt((state) => state.pending)
  const answer = useImportPrompt((state) => state.answer)

  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && answer(null)}>
      {pending && (
        <DialogContent
          title={pending.count > 1 ? `导入 ${pending.count} 个文件到哪里？` : '导入到哪里？'}
          className="w-[440px] max-w-[92vw]"
          aria-describedby={undefined}
        >
          <div className="grid gap-2">
            <ChoiceCard
              autoFocus
              icon={<FileStack size={20} />}
              title="并入当前项目"
              desc={
                <>
                  页面追加到 <span className="break-all font-medium text-ink">{pending.currentName}</span> 末尾，
                  已放置的印章原样保留，可一键撤销。
                </>
              }
              onSelect={() => answer('current')}
            />
            <ChoiceCard
              icon={<FilePlus size={20} />}
              title="作为新项目打开"
              desc="加入文件列表并立即打开，当前项目不受影响。"
              onSelect={() => answer('new')}
            />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-ink-muted">
            小技巧：直接把文件拖进窗口，往左半边放 = 并入当前，往右半边放 = 新项目。
          </p>
        </DialogContent>
      )}
    </Dialog>
  )
}

function ChoiceCard({
  icon,
  title,
  desc,
  onSelect,
  autoFocus
}: {
  icon: ReactNode
  title: string
  desc: ReactNode
  onSelect: (target?: ImportTarget) => void
  autoFocus?: boolean
}) {
  return (
    <button
      type="button"
      autoFocus={autoFocus}
      onClick={() => onSelect()}
      className="group flex items-start gap-3 rounded-xl border border-line bg-panel p-3.5 text-left transition-all duration-150 hover:border-accent hover:bg-accent-soft/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/60"
    >
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-sunken text-ink-muted transition-colors group-hover:bg-accent group-hover:text-white">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">{desc}</span>
      </span>
    </button>
  )
}
