import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: './',
  plugins: [vue(), tailwindcss()],
  server: {
    port: 5178,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3018',
      '/prototype-files': 'http://127.0.0.1:3018'
    }
  },
  build: {
    outDir: 'dist'
  }
})
