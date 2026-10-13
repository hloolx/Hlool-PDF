import { Check, Download, RefreshCw } from 'lucide-react'
import { prepareOffline, useOffline } from './offline'
import { MenuItem } from '../ui/Menu'

export function OfflineStatus() {
  const status = useOffline((state) => state.status)
  const text = {
    development: '开发预览 · 离线缓存未启用',
    unsupported: '离线打开需使用 HTTPS 或本机地址',
    preparing: '正在准备离线资源…',
    ready: '离线已就绪',
    update: '新版已就绪 · 关闭所有窗口后生效',
    error: '离线资源未准备完成'
  }[status]
  return (
    <div>
      <div className="flex items-center gap-2 text-xs text-ink-muted" role="status" data-testid="offline-status">
        {status === 'ready' ? <Check size={14} aria-hidden /> : <Download size={14} aria-hidden />}
        <span>{text}</span>
      </div>
      {status === 'error' && (
        <MenuItem className="mt-1 text-accent" onSelect={(event) => { event.preventDefault(); void prepareOffline({ repair: true }) }}>
          <RefreshCw size={12} aria-hidden />重新准备离线资源
        </MenuItem>
      )}
    </div>
  )
}
