import { useEffect } from 'react'
import { create } from 'zustand'
import { useEditorStore } from '../../state/store'

type FxKind = 'to-dark' | 'to-light'

const FLIP_AT_MS = 640
const TOTAL_MS = 1600

type FxState = {
  fx: FxKind | null
  start: (fx: FxKind) => void
  clear: () => void
}

const useThemeFx = create<FxState>((set) => ({
  fx: null,
  start: (fx) => set({ fx }),
  clear: () => set({ fx: null })
}))

/** 主题切换：变暗 = 乌云压境后揭开夜色；变亮 = 旭日升起铺开晨光。 */
export function toggleTheme() {
  const state = useEditorStore.getState()
  const next = state.theme === 'light' ? 'dark' : 'light'
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || useThemeFx.getState().fx) {
    state.setTheme(next)
    return
  }
  useThemeFx.getState().start(next === 'dark' ? 'to-dark' : 'to-light')
}

export function ThemeFxLayer() {
  const fx = useThemeFx((state) => state.fx)

  useEffect(() => {
    if (!fx) return
    const flip = window.setTimeout(() => {
      useEditorStore.getState().setTheme(fx === 'to-dark' ? 'dark' : 'light')
    }, FLIP_AT_MS)
    const done = window.setTimeout(() => useThemeFx.getState().clear(), TOTAL_MS)
    return () => {
      window.clearTimeout(flip)
      window.clearTimeout(done)
    }
  }, [fx])

  if (!fx) return null
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[120] overflow-hidden"
      style={{ animation: `fx-veil ${TOTAL_MS}ms ease-in-out both` }}
      aria-hidden
    >
      {fx === 'to-dark' ? <NightScene /> : <DawnScene />}
    </div>
  )
}

function NightScene() {
  return (
    <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, #0b1020 0%, #131a2c 55%, #1b2334 100%)' }}>
      {/* 月亮 */}
      <div
        className="absolute right-[14%] top-[16%] size-20 rounded-full"
        style={{
          background: '#f4f0dc',
          boxShadow: '0 0 60px 18px rgb(244 240 220 / 0.25), inset -14px -10px 0 0 #d8d2b4',
          animation: 'fx-moon 1600ms ease-in-out both'
        }}
      />
      {/* 星星 */}
      {[
        ['18%', '22%', 3],
        ['34%', '12%', 2],
        ['52%', '26%', 2.5],
        ['68%', '10%', 2],
        ['80%', '34%', 3],
        ['10%', '44%', 2]
      ].map(([left, top, size], i) => (
        <span
          key={i}
          className="absolute rounded-full bg-white/90"
          style={{
            left: String(left),
            top: String(top),
            width: Number(size),
            height: Number(size),
            animation: `fx-star 1600ms ease-in-out both`,
            animationDelay: `${i * 40}ms`
          }}
        />
      ))}
      {/* 乌云压境 */}
      <div className="absolute inset-x-[-12%] top-0 h-[68%]" style={{ animation: 'fx-clouds 1600ms cubic-bezier(0.3, 0, 0.2, 1) both' }}>
        {[
          ['2%', '4%', 340, 130, 0.95],
          ['26%', '-6%', 420, 160, 0.9],
          ['52%', '6%', 380, 140, 0.95],
          ['74%', '-4%', 430, 170, 0.9],
          ['14%', '24%', 460, 150, 0.8],
          ['58%', '28%', 500, 160, 0.8]
        ].map(([left, top, w, h, opacity], i) => (
          <span
            key={i}
            className="absolute rounded-full"
            style={{
              left: String(left),
              top: String(top),
              width: Number(w),
              height: Number(h),
              opacity: Number(opacity),
              background: 'radial-gradient(closest-side, #2b3247 0%, #232a3d 60%, transparent 100%)',
              filter: 'blur(14px)'
            }}
          />
        ))}
      </div>
    </div>
  )
}

function DawnScene() {
  return (
    <div
      className="absolute inset-0"
      style={{
        background:
          'linear-gradient(180deg, #93b9e4 0%, #cfdcec 36%, #f7dcb6 62%, #ffc98f 84%, #ffb974 100%)'
      }}
    >
      {/* 夜空残星在晨光中淡出 */}
      {[
        ['16%', '12%', 2.5],
        ['38%', '7%', 2],
        ['60%', '14%', 2.5],
        ['82%', '9%', 2]
      ].map(([left, top, size], i) => (
        <span
          key={i}
          className="absolute rounded-full bg-white/90"
          style={{
            left: String(left),
            top: String(top),
            width: Number(size),
            height: Number(size),
            animation: 'fx-star-out 1600ms ease-out both',
            animationDelay: `${i * 60}ms`
          }}
        />
      ))}
      {/* 晨云缓缓飘入 */}
      {[
        ['4%', '16%', 330, 110, 0.8],
        ['42%', '9%', 390, 120, 0.7],
        ['66%', '24%', 370, 130, 0.75]
      ].map(([left, top, w, h, opacity], i) => (
        <span
          key={i}
          className="absolute rounded-full"
          style={{
            left: String(left),
            top: String(top),
            width: Number(w),
            height: Number(h),
            opacity: Number(opacity),
            background:
              'radial-gradient(closest-side, rgb(255 244 232 / 0.95) 0%, rgb(255 226 200 / 0.55) 60%, transparent 100%)',
            filter: 'blur(14px)',
            animation: 'fx-dawn-cloud 1600ms ease-out both',
            animationDelay: `${i * 90}ms`
          }}
        />
      ))}
      {/* 地平线霞光随日出渐亮 */}
      <div
        className="absolute inset-x-0 bottom-0 h-[58%]"
        style={{
          background:
            'radial-gradient(120% 95% at 50% 102%, rgb(255 178 100 / 0.85) 0%, rgb(255 202 138 / 0.42) 45%, transparent 72%)',
          animation: 'fx-horizon 1600ms ease-in-out both'
        }}
      />
      {/* 太阳：柔光多层光晕呼吸 + 暖色日轮，无机械光芒线 */}
      <div
        className="absolute left-1/2 top-[32%]"
        style={{ animation: 'fx-sun-rise 1600ms cubic-bezier(0.25, 0, 0.25, 1) both' }}
      >
        <SunHalo
          size={440}
          duration={3000}
          background="radial-gradient(closest-side, rgb(255 174 96 / 0.34) 0%, rgb(255 174 96 / 0.14) 55%, transparent 75%)"
        />
        <SunHalo
          size={220}
          duration={2200}
          background="radial-gradient(closest-side, rgb(255 208 118 / 0.6) 0%, rgb(255 208 118 / 0.24) 60%, transparent 82%)"
        />
        <div
          className="absolute left-0 top-0 size-[88px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            background: 'radial-gradient(circle at 36% 32%, #fff6cf 0%, #ffd166 50%, #ffa047 88%, #ff8f3a 100%)',
            boxShadow: '0 0 70px 24px rgb(255 178 92 / 0.55), 0 0 160px 60px rgb(255 160 80 / 0.25)'
          }}
        />
      </div>
    </div>
  )
}

/** 居中于太阳锚点的呼吸光晕层（缩放动画放内层，避免覆盖外层的居中 transform）。 */
function SunHalo({ size, duration, background }: { size: number; duration: number; background: string }) {
  return (
    <div className="absolute left-0 top-0 -translate-x-1/2 -translate-y-1/2">
      <div
        className="rounded-full"
        style={{
          width: size,
          height: size,
          background,
          animation: `fx-sun-glow ${duration}ms ease-in-out infinite alternate`
        }}
      />
    </div>
  )
}
