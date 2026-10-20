import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [vue()],
  resolve: { alias: { '@shared': fileURLToPath(new URL('../../src/shared', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true }
})
