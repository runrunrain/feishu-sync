import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

const DEFAULT_BACKEND_PORT = 3001

function parseBackendPort(rawValue: string | undefined): number {
  const trimmedValue = rawValue?.trim()
  if (!trimmedValue) {
    return DEFAULT_BACKEND_PORT
  }

  const parsed = Number.parseInt(trimmedValue, 10)
  if (
    !Number.isInteger(parsed) ||
    String(parsed) !== trimmedValue ||
    parsed < 1 ||
    parsed > 65535
  ) {
    console.warn(`[vite] Ignoring invalid BACKEND_PORT; using ${DEFAULT_BACKEND_PORT}.`)
    return DEFAULT_BACKEND_PORT
  }

  return parsed
}

const devProxyTarget = `http://127.0.0.1:${parseBackendPort(process.env.BACKEND_PORT)}`

export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: devProxyTarget,
        changeOrigin: true,
      },
    },
  },
  assetsInclude: ['**/*.svg', '**/*.csv'],
})
