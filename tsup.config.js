import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/**/*.ts',
    'src/**/*.tsx',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
    '!src/**/*.test.tsx',
  ],
  outDir: 'dist',
  bundle: false,
  clean: false,
  dts: false,
  sourcemap: true,
  format: ['esm'],
  outExtension() {
    return { js: '.js' }
  },
  treeshake: true,
})
