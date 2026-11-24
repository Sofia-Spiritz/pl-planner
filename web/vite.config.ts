import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The React version of the dashboard. It is built into ../next and served by GitHub Pages
// at /pl-planner/next/, beside the original dashboard, until it replaces it.
export default defineConfig({
  base: '/pl-planner/next/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  build: { outDir: '../next', emptyOutDir: true, chunkSizeWarningLimit: 2500 },
})
