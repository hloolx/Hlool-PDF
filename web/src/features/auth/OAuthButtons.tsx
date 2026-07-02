import { Github } from 'lucide-react'
import { Button } from '../../ui/Button'

const OAUTH_PROVIDERS: Array<{
  kind: string
  name: string
  icon: (props: { size?: number }) => React.ReactNode
  color: string
}> = [
  {
    kind: 'github',
    name: 'GitHub',
    icon: ({ size }) => <Github size={size} />,
    color: 'bg-[#24292e] hover:bg-[#1a1e22] text-white',
  },
  {
    kind: 'google',
    name: 'Google',
    icon: () => (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
      </svg>
    ),
    color: 'bg-white hover:bg-gray-50 text-ink border border-line',
  },
  {
    kind: 'linuxdo',
    name: 'LinuxDo',
    icon: () => <span className="font-bold">L</span>,
    color: 'bg-[#0066cc] hover:bg-[#0052a3] text-white',
  },
]

/** 只渲染后端 /auth/config 声明已配置的提供方；一个都没有时整块不出现。 */
export function OAuthButtons({ providers }: { providers: string[] }) {
  const enabled = OAUTH_PROVIDERS.filter((p) => providers.includes(p.kind))
  if (enabled.length === 0) return null

  return (
    <div className="grid gap-2">
      {enabled.map((provider) => (
        <Button
          key={provider.kind}
          type="button"
          className={provider.color}
          onClick={() => {
            window.location.href = `/auth/oauth/${provider.kind}`
          }}
        >
          <provider.icon size={16} />
          使用 {provider.name} 登录
        </Button>
      ))}
    </div>
  )
}
