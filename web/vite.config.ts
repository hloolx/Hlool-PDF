import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8088',
      '/auth': 'http://127.0.0.1:8088',
      '/healthz': 'http://127.0.0.1:8088'
    }
  },
  build: {
    outDir: '../internal/webui/dist',
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
