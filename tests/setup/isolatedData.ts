import { beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// setupFiles 在每个测试文件的业务模块导入前执行；直接设置基线使 unstubAllEnvs 也回到隔离目录。
const testRoot = mkdtempSync(join(tmpdir(), 'cai-tools-vitest-'))
const dataRoot = join(testRoot, 'data')
const legacyRoot = join(testRoot, 'legacy')
mkdirSync(dataRoot)
mkdirSync(legacyRoot)

/**
 * 恢复当前测试文件的数据基线，允许具体用例随后设置更细的隔离目录。
 * @returns 无返回值。
 */
function isolateData(): void {
  process.env.ZTOOLS_DATA_ROOT = dataRoot
  process.env.ZTOOLS_LEGACY_USER_DATA_PATH = legacyRoot
}

isolateData()
beforeEach(isolateData)

// 含真实 LMDB 单例的文件在工作进程退出前仍持有句柄；交给系统临时目录清理，避免抢先删除活动数据库。
