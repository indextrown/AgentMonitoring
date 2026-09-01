import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react()],
  build: {
    outDir: resolve('out/web'),
    emptyOutDir: true
  }
})
