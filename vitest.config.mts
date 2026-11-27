import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    env: { TZ: 'UTC' },
    // Pre-bundled for import speed: vi.mock a whole package here, never one of its internal files.
    deps: { optimizer: { ssr: { enabled: true, include: ['zklighter-perps', 'date-fns'] } } },
  },
})
