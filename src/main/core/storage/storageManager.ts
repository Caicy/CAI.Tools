import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import LmdbDatabase from '../lmdb'
import {
  ensure3Layout,
  type AppDataPathOptions,
  type ZToolsDataLayout
} from '../appData/appDataPaths'
import { readDataVersion, writeDataVersion } from '../appData/appDataVersion'
import { StorageRouter } from './storageRouter'
import { unavailableOfficialCapability } from '../../../shared/localEdition'

const DEFAULT_MAP_SIZE = 2 * 1024 * 1024 * 1024
const DEFAULT_MAX_DBS = 6

export interface StorageInitState {
  firstRun: boolean
  legacyLmdbFound: boolean
  importedFromLegacy: boolean
  layout: ZToolsDataLayout
}

export interface StorageManagerOptions extends AppDataPathOptions {
  mapSize?: number
}

export class StorageManager extends EventEmitter {
  private deviceDb: LmdbDatabase | null = null
  private accountDb: LmdbDatabase | null = null
  private router: StorageRouter | null = null
  private currentAccountUid: string | null = null
  private initState: StorageInitState | null = null

  constructor(private options: StorageManagerOptions = {}) {
    super()
  }

  /**
   * 初始化设备与默认空间，忽略旧账号并禁止自动探测原版数据库。
   * @returns 当前本地存储初始化状态。
   */
  init(): StorageInitState {
    if (this.initState && this.deviceDb && this.accountDb && this.router) {
      return this.initState
    }

    // 本地版全新开始只检查自身版本，不访问兼容目录或官方账号空间。
    const existingVersion = readDataVersion(this.options)
    const firstRun = !existingVersion
    const legacyLmdbFound = false
    const layout = ensure3Layout(this.options)
    const version = existingVersion || writeDataVersion({ importedFromLegacy: false }, this.options)

    // 即使设备库残留 uid，也只打开 default，旧账号目录保持原样。
    this.deviceDb = this.openDb(layout.deviceLmdbPath)
    this.currentAccountUid = null
    this.accountDb = this.openDb(layout.defaultAccountLmdbPath)
    this.router = new StorageRouter(this)
    this.router.bindAccountDb(this.accountDb)

    this.initState = {
      firstRun,
      legacyLmdbFound,
      importedFromLegacy: Boolean(version?.importedFromLegacy),
      layout
    }
    return this.initState
  }

  getInitState(): StorageInitState {
    return this.init()
  }

  getLayout(): ZToolsDataLayout {
    return this.init().layout
  }

  getDeviceDb(): LmdbDatabase {
    this.init()
    return this.deviceDb!
  }

  getAccountDb(): LmdbDatabase {
    this.init()
    return this.accountDb!
  }

  getRouter(): StorageRouter {
    this.init()
    return this.router!
  }

  getCurrentAccountUid(): string | null {
    this.init()
    return this.currentAccountUid
  }

  /**
   * 保持默认本地数据空间，并明确拒绝切换官方账号。
   * @param uid 请求的账号标识；空值表示默认本地空间。
   * @returns 无返回值。
   * @throws 非空账号请求时抛出官方能力不可用错误。
   */
  switchAccount(uid?: string | null): void {
    // 在初始化前拒绝账号请求，确保失败操作不创建账号目录或修改状态。
    if (uid?.trim()) {
      const failure = unavailableOfficialCapability('账号切换')
      throw Object.assign(new Error(failure.error), { code: failure.code })
    }
    this.init()
  }

  /**
   * 关闭当前账号数据库、切回默认数据空间，并永久删除该账号的本地数据库目录。
   * @param uid 要删除的当前账号标识。
   * @returns 无返回值。
   * @throws 账号标识为空、与当前账号不一致或目录边界校验失败时抛出错误。
   */
  deleteCurrentAccount(uid: string): void {
    this.init()
    const normalizedUid = uid?.trim()

    // 只允许调用方删除当前已激活账号，避免误删默认空间或其他账号。
    if (!normalizedUid) throw new Error('删除本地账号数据时账号标识不能为空')
    if (!this.currentAccountUid || normalizedUid !== this.currentAccountUid) {
      throw new Error('待删除账号与当前本地账号不一致')
    }

    const layout = this.getLayout()
    const accountsRoot = path.resolve(layout.accountsRoot)
    const accountPath = path.resolve(this.accountPathForUid(normalizedUid, layout))
    const defaultAccountPath = path.resolve(layout.defaultAccountLmdbPath)

    // 删除目标必须是 accounts 的直属哈希目录，且绝不能命中默认数据空间。
    if (path.dirname(accountPath) !== accountsRoot || accountPath === defaultAccountPath) {
      throw new Error('待删除账号目录超出允许范围')
    }

    // 先切换并关闭旧 LMDB 句柄，确保文件系统允许递归删除账号目录。
    this.switchAccount(null)

    // 状态切换完成后再做不可恢复的目录清理，保留默认空间和其他账号数据。
    fs.rmSync(accountPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }

  close(): void {
    this.router?.unbind()
    this.router = null
    for (const db of [this.accountDb, this.deviceDb]) {
      try {
        db?.close()
      } catch (error) {
        console.error('[Storage] close db failed:', error)
      }
    }
    this.accountDb = null
    this.deviceDb = null
    this.currentAccountUid = null
    this.initState = null
  }

  private openDb(dbPath: string): LmdbDatabase {
    return new LmdbDatabase({
      path: dbPath,
      mapSize: this.options.mapSize || DEFAULT_MAP_SIZE,
      maxDbs: DEFAULT_MAX_DBS
    })
  }

  private accountPathForUid(uid: string | null, layout: ZToolsDataLayout): string {
    return uid ? path.join(layout.accountsRoot, hashAccountId(uid)) : layout.defaultAccountLmdbPath
  }
}

export function hashAccountId(uid: string): string {
  return crypto.createHash('sha256').update(uid).digest('hex').slice(0, 16)
}

export const storageManager = new StorageManager()
