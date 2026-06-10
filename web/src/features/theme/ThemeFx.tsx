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
    <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, #aed5f2 0%, #fbe9c0 58%, #ffd98f 100%)' }}>
      {/* 太阳与光芒 */}
      <div className="absolute left-1/2 top-[30%]" style={{ animation: 'fx-sun-rise 1600ms cubic-bezier(0.25, 0, 0.25, 1) both' }}>
        <div className="relative">
          <div className="absolute left-1/2 top-1/2" style={{ animation: 'fx-spin-slow 9s linear infinite' }}>
            {Array.from({ length: 12 }, (_, i) => (
              <span
                key={i}
                className="absolute left-1/2 top-1/2 origin-center rounded-full"
                style={{
                  width: 7,
                  height: 120,
                  background: 'linear-gradient(180deg, rgb(255 196 64 / 0.95) 0%, transparent 78%)',
                  transform: `translate(-50%, -50%) rotate(${i * 30}deg) translateY(-86px)`
                }}
              />
            ))}
          </div>
          <div
            className="relative size-24 -translate-x-1/2 rounded-full"
            style={{
              marginLeft: '50%',
              background: 'radial-gradient(circle at 38% 34%, #ffe9a8 0%, #ffc640 62%, #f7a72a 100%)',
              boxShadow: '0 0 80px 30px rgb(255 198 64 / 0.55)'
            }}
          />
        </div>
      </div>
    </div>
  )
}
