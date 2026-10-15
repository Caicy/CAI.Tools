import { defineConfig } from 'vitest/config'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const packageJson = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'))

export default defineConfig({
  define: {
    __ZTOOLS_TARGET_ELECTRON_VERSION__: JSON.stringify(packageJson.devDependencies.electron)
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup/isolatedData.ts'],
    // 限制 Windows worker 争用，避免全量测试的模块转换挤占单例初始化时限。
    maxWorkers: 4,
    include: ['tests/**/*.test.ts']
  },
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  }
})
