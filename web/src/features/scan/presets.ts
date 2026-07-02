import type { ScanConfig } from '../../lib/types'

/** 扫描效果预设的唯一定义处(检查器按钮与默认值都从这里取)。 */
export const SCAN_PRESETS: Record<string, { label: string; config: Partial<ScanConfig> }> = {
  'light-scan': {
    label: '轻度扫描',
    config: {
      rotate: 0.3,
      rotateVariance: 0.2,
      colorspace: 'sRGB',
      blur: 0.15,
      noise: 0.08,
      brightness: 1.01,
      yellowish: 0.03,
      contrast: 1.02,
      border: false
    }
  },
  'office-copy': {
    label: '办公复印',
    config: {
      rotate: 0.6,
      rotateVariance: 0.3,
      colorspace: 'sRGB',
      blur: 0.25,
      noise: 0.12,
      brightness: 1.02,
      yellowish: 0.08,
      contrast: 1.05,
      border: false
    }
  },
  'aged-paper': {
    label: '陈旧纸张',
    config: {
      rotate: 1.2,
      rotateVariance: 0.5,
      colorspace: 'sRGB',
      blur: 0.35,
      noise: 0.18,
      brightness: 0.98,
      yellowish: 0.25,
      contrast: 1.08,
      border: true
    }
  },
  'bw-scan': {
    label: '黑白扫描',
    config: {
      rotate: 0.8,
      rotateVariance: 0.4,
      colorspace: 'gray',
      blur: 0.3,
      noise: 0.15,
      brightness: 1.05,
      yellowish: 0,
      contrast: 1.12,
      border: false
    }
  }
}
