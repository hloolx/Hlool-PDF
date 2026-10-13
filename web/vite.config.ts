import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { offlinePlugin } from './build/offlinePlugin'
import { pdfAssetsPlugin } from './build/pdfAssetsPlugin'

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfAssetsPlugin(), offlinePlugin()],
  // Pre-bundle lazy engines so dependency discovery cannot reload an E2E job.
  optimizeDeps: { include: ['@neslinesli93/qpdf-wasm', 'jszip', 'pdf-lib', 'pdfjs-dist'] },
  // 本地盖章 Worker（stampWorker.ts）内部有动态 import（pdf-lib/qpdf 懒加载），
  // 代码分割要求 ES 模块格式的 worker（目标浏览器均支持 module worker）。
  worker: { format: 'es' },
  server: {
    host: '127.0.0.1',
    hmr: process.env.HLOOL_E2E === '1' ? false : undefined,
    port: 5173
  },
  preview: {
    headers: {
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // 把变动很少的重依赖拆成独立 chunk：长效缓存 + 并行下载。
        // pdfjs 体积最大且仅工作区用到，单独成包；其余框架依赖归 vendor。
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('pdfjs-dist')) return 'pdfjs'
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|radix-ui|@radix-ui|zustand|zundo)[\\/]/.test(id)) {
            return 'vendor'
          }
        }
      }
    }
  }
})
