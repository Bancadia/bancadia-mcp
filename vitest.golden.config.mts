import { defineConfig } from 'vitest/config'
// Plain Node pool (no workerd): needs fs. Only used by `npm run capture:goldens`.
export default defineConfig({ test: { include: ['scripts/capture-goldens.capture.ts'], environment: 'node' } })
