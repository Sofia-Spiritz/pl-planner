import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The dashboard. It builds into web/dist with relative addresses, so the same build works
// wherever it is served from. scripts/build-web.mjs runs the build and copies the result
// to the project root, which GitHub Pages serves at /pl-planner/.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2500 },
})
