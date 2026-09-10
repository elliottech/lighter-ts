import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom', 'zustand', '@tanstack/react-query', 'zklighter-perps'],
  },
  define: {
    'process.env.VITE_PLAYWRIGHT': JSON.stringify(process.env.VITE_PLAYWRIGHT ?? ''),
  },
})
