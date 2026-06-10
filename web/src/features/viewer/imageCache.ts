import { useEffect, useState } from 'react'

const cache = new Map<string, Promise<HTMLImageElement>>()

export function loadImage(url: string): Promise<HTMLImageElement> {
  let entry = cache.get(url)
  if (!entry) {
    entry = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`无法加载图片 ${url}`))
      img.src = url
    })
    cache.set(url, entry)
  }
  return entry
}

export function useImage(url: string | null) {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  useEffect(() => {
    setImg(null)
    if (!url) return
    let cancelled = false
    loadImage(url)
      .then((loaded) => {
        if (!cancelled) setImg(loaded)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [url])
  return img
}
