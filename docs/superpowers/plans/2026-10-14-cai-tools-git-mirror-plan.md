# CAI.Tools Git 同步目录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task when delegated execution is chosen. Steps use checkbox (`- [ ]`) syntax for tracking. Inline execution follows the same tasks and checks.

**Goal:** 应用自动把可迁移状态写入 Git 工作目录，用户在外部操作 Git；运行中可拉取，重启后安全加载。

**Architecture:** 以现有 LMDB 为本机运行存储，事务内 journal 跟踪修改，严格适配器投影为稳定 JSON 与原始插件程序包。外部变化使写入暂停；启动准备器在业务模块加载之前进行三方比对与新代次构建，最后切换一个指针。Git 仅作只读状态/对象查询，修改型 Git 操作由用户完成。

**Tech Stack:** Node.js 文件 API、crypto、child_process.execFile、现有 chokidar 4、LMDB、TypeScript、Vitest、Playwright Electron；使用用户已有的 Git 可执行文件。

---

开始日期：2026-10-14；整理完成：2026-10-15。依赖：[计划 A](./2026-10-14-cai-tools-local-edition-plan.md)。需求及协议：[具体设计](./2026-10-14-cai-tools-git-local-design.md)。下面的新类型与纯函数是实现合同/起始代码，不是已经部署的功能。

当前进度（2026-10-15）：B 阶段已授权启动，B1、B2 已实施并完成本机验证；B3–B9 尚未实施。实际结果与限制见[阶段证据](./evidence/git-mirror-acceptance.md)。用户要求的 A+B1 检查点已本地提交为 bdf563c；B2 保留未提交改动，未推送、发布或部署。

## 文件责任与依赖顺序

| 文件                                                                       | 责任                                     |
| -------------------------------------------------------------------------- | ---------------------------------------- |
| `src/shared/gitMirrorTypes.ts`                                             | 格式、状态和 IPC 类型。                  |
| `src/main/core/gitMirror/canonicalJson.ts`                                 | JSON 严格读取、重复键检测、稳定序列化。  |
| `src/main/core/gitMirror/pathSafety.ts`                                    | 工作目录和包路径的 Windows 安全检查。    |
| `src/main/core/gitMirror/adapters/types.ts`                                | 插件投影与本机还原合同。                 |
| `src/main/core/gitMirror/adapters/codeSnippets.ts`                         | code-snippets 1.2.0 适配。               |
| `src/main/core/gitMirror/adapters/aiHelper.ts`                             | ai-helper 1.2.1 适配。                   |
| `src/main/core/gitMirror/adapters/registry.ts`                             | 确切版本匹配，未知插件默认本机数据。     |
| `src/main/core/gitMirror/hostProjection.ts`                                | 宿主白名单与凭据分离。                   |
| `src/main/core/gitMirror/gitReadonly.ts`                                   | 受限只读 Git 调用，兼容 worktree。       |
| `src/main/core/gitMirror/snapshotReader.ts`                                | 稳定读取、引用与包/附件完整性校验。      |
| `src/main/core/gitMirror/journal.ts`                                       | LMDB 事务内 dirty 标记及按序号确认。     |
| `src/main/core/gitMirror/reconcile.ts`                                     | 对每个对象作三方比较，保留冲突材料。     |
| `src/main/core/gitMirror/atomicFile.ts`                                    | 本机临时文件 flush/发布与失败回收。      |
| `src/main/core/gitMirror/packageArtifacts.ts`                              | 捕获原始安装包，摘要和归档安全检查。     |
| `src/main/core/gitMirror/exportService.ts`                                 | 自动导出、去抖、外部变化暂停、退出协调。 |
| `src/main/core/gitMirror/localState.ts`                                    | 基线、repoPath、冲突与本机协调记录。     |
| `src/main/core/gitMirror/generationStore.ts`                               | 新代次构造、单指针发布、启动失败回退。   |
| `src/main/core/gitMirror/bootstrap.ts`                                     | 不导入业务 singleton 的启动准备。        |
| `src/main/api/renderer/gitMirror.ts`                                       | 内置设置插件权限校验与有限 IPC。         |
| `internal-plugins/setting/src/views/GitMirrorSetting/GitMirrorSetting.vue` | 路径选择、范围、状态、重启与冲突位置。   |

既有修改点：`src/main/index.ts`、`src/main/appMain.ts`、`src/main/managers/windowManager.ts`、`src/main/core/appData/appDataPaths.ts`、`src/main/core/lmdb/index.ts`、`src/main/core/lmdb/syncApi.ts`、`src/main/core/storage/storageRouter.ts`、`src/main/core/storage/storageManager.ts`、`src/main/api/index.ts`、`src/main/api/renderer/pluginInstaller.ts`、`src/main/api/renderer/plugins.ts`、`src/main/core/aiProviderService.ts`、`src/shared/storageKeys.ts`、`src/shared/aiProviderShared.ts`、资源/main preload、设置 env.d.ts 和 router。

## Task B1：协议、JSON 与路径边界

**Files:** Create shared types、canonicalJson、pathSafety；Test `tests/main/gitMirrorFormat.test.ts`。

- [x] 定义实际使用的最小类型：

```ts
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type MirrorState =
  | 'unconfigured'
  | 'ready'
  | 'waiting-for-git'
  | 'external-change'
  | 'conflict'
  | 'invalid'
  | 'unavailable'
export interface ProfileManifest {
  format: 'cai-tools-profile'
  schemaVersion: 1
  profileId: string
}
export interface PortableRecord {
  schemaVersion: 1
  plugin: string
  adapter: string
  key: string
  deleted: boolean
  payload: Json
}
export interface PluginArtifact {
  name: string
  version: string
  installed: boolean
  packagePath: string | null
  sha256: string | null
  platform: 'win32'
}
export interface MirrorStatus {
  state: MirrorState
  repoPath: string | null
  pending: number
  restartRequired: boolean
  issues: { code: string; relativePath?: string; message: string }[]
}
```

- [x] 写并运行确定的失败测试：

```ts
import { expect, test } from 'vitest'
import { strictParseJson, canonicalJson } from '../../src/main/core/gitMirror/canonicalJson'
test('同内容异键顺序输出相同，不携带运行时噪声', () => {
  expect(canonicalJson({ b: 2, a: 1 })).toBe('{\n  "a": 1,\n  "b": 2\n}\n')
  expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
})
test('拒绝重复键和转义后的同名键', () => {
  expect(() => strictParseJson('{"a":1,"a":2}')).toThrow('DUPLICATE_JSON_KEY')
  expect(() => strictParseJson('{"a":1,"\\u0061":2}')).toThrow('DUPLICATE_JSON_KEY')
})
test('正文中的 Git 标记不是文件冲突标记', () => {
  expect(strictParseJson('{"text":"<<<<<<< sample"}')).toEqual({ text: '<<<<<<< sample' })
})
```

Run: `pnpm exec vitest run tests/main/gitMirrorFormat.test.ts`。先确认新增函数未实现导致失败。

- [x] 实现严格 JSON：先 JSON.parse 校验语法，再扫描字符串 token 与对象栈，检测语法校验不能发现的重复键；使用下面完整核心代码，不用正则猜测正文秘密：

```ts
import type { Json } from '../../../shared/gitMirrorTypes'

/**
 * 读取严格 JSON 并拒绝重复对象键和原型相关键。
 * @param text 待校验的 UTF-8 文本。
 * @returns JSON 值。
 * @throws 语法、重复键、深度或危险键错误时抛错。
 */
export function strictParseJson(text: string): Json {
  const value = JSON.parse(text) as Json
  const stack: (Set<string> | null)[] = []
  // JSON.parse 已校验语法，此遍历只跟踪字符串及对象作用域。
  for (let index = 0; index < text.length; index++) {
    const token = text[index]
    if (token === '{' || token === '[') {
      stack.push(token === '{' ? new Set<string>() : null)
      if (stack.length > 64) throw new Error('JSON_TOO_DEEP')
    } else if (token === '}' || token === ']') {
      stack.pop()
    } else if (token === '"') {
      const start = index
      for (index++; index < text.length; index++) {
        if (text[index] === '\\') {
          index++
          continue
        }
        if (text[index] === '"') break
      }
      let next = index + 1
      while (/\s/.test(text[next] || '') && next < text.length) next++
      if (text[next] !== ':') continue
      const key = JSON.parse(text.slice(start, index + 1)) as string
      if (['__proto__', 'prototype', 'constructor'].includes(key))
        throw new Error('UNSAFE_JSON_KEY')
      const keys = stack[stack.length - 1]
      if (!keys) throw new Error('INVALID_OBJECT_SCOPE')
      if (keys.has(key)) throw new Error('DUPLICATE_JSON_KEY')
      keys.add(key)
    }
  }
  return value
}

/**
 * 按对象键排序生成可比较的 JSON，保留数组顺序。
 * @param value 已校验的 JSON 值。
 * @returns 带 LF 末尾换行的稳定文本。
 * @throws 非有限数值时抛错。
 */
export function canonicalJson(value: Json): string {
  // 子对象递归排序，字符串与数组顺序保持业务原意。
  return JSON.stringify(sortJson(value), null, 2) + '\n'
}

/**
 * 复制并排序 JSON 中的对象字段。
 * @param value 待处理的 JSON 值。
 * @returns 可稳定序列化的值。
 * @throws 非有限数值时抛错。
 */
function sortJson(value: Json): Json {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('INVALID_NUMBER')
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === 'object') {
    const result: { [key: string]: Json } = Object.create(null)
    for (const key of Object.keys(value).sort()) result[key] = sortJson(value[key])
    return result
  }
  return value
}
```

- [x] pathSafety 以 SHA-256 生成记录文件名；插件名复用 assertSafePluginArtifactPart。逐级 lstat 拒绝符号链接、junction/reparse 跳转；realpath + path.relative 检查父子关系，拒绝 `..`、绝对路径、UNC、NTFS ADS、大小写重名、保留设备名。
- [x] 选择同步目录时拒绝与本机数据根互相包含；所有文件写入只涉及协议拥有的路径，不清空用户工作目录。
- [x] 初始化受管 `.gitattributes` 规则如下，追加到用户文件的受管块且不覆盖其他规则；JSON 指纹使用解析后的 canonicalJson，程序包/附件用原始 bytes 摘要：

```gitattributes
profile.json text eol=lf
host/**/*.json text eol=lf
plugins/*.json text eol=lf
records/**/*.json text eol=lf
packages/**/*.zpx -text
blobs/** -text
```

- [x] 添加 `../`、`C:\`、`file:stream`、CON、symlink、64 层以上深度与重复 JSON 键测试；重跑 B1，通过后审查并记录；依交接约束不提交。

## Task B2：插件与宿主数据投影

**Files:** Create adapters/types、registry、codeSnippets、aiHelper、hostProjection；Modify aiProviderService 的本机密钥存储、shared/storageKeys、shared/aiProviderShared；Test `tests/main/gitMirrorAdapters.test.ts`。

- [x] 完整适配器端口如下；所有实现只处理明确匹配的文档，export/import 保留同步插件调用的行为：

```ts
import type { Json } from '../../../../shared/gitMirrorTypes'
export interface Adapter {
  name: string
  pluginVersion: string
  adapterVersion: string
  acceptsKey(key: string): boolean
  exportPayload(key: string, localDocument: Json): Json
  importPayload(key: string, payload: Json, previousDocument: Json | null): Json
}
export interface AdapterLookup {
  get(name: string, exactVersion: string): Adapter | null
}
```

- [x] code-snippets 只接受 `tpl_` 文档。字段 schema：\_id/name/description/language/tags/code/usageCount/pinned/createdAt/updatedAt，外加宿主已声明 revision 元信息。未知业务字段使该插件数据状态变为 unsupported，绝不默认扩展。
- [x] 投影白名单为 name、description、language、tags、code、pinned、createdAt；验证字符串、字符串数组、布尔和日期格式。导入拼接本机 namespace，合并本机 usageCount 与 updatedAt，已有统计不被远端 0 覆盖。完整字段投影核心为：

```ts
/**
 * 提取模板的可迁移内容，不包含本机使用统计。
 * @param doc 已通过模板 schema 校验的对象。
 * @returns 模板内容投影。
 */
export function projectTemplate(doc: {
  name: string
  description: string
  language: string
  tags: string[]
  code: string
  pinned?: boolean
  createdAt: string
}) {
  // 显式列字段，新增配置不能隐式进入同步目录。
  return {
    name: doc.name,
    description: doc.description,
    language: doc.language,
    tags: [...doc.tags],
    code: doc.code,
    pinned: doc.pinned === true,
    createdAt: doc.createdAt
  }
}
```

- [x] ai-helper 只接受 `conv/<id>` 与已声明的 `selected_model`。使用 strictParseJson 读取会话 data；Conversation 字段 id/title/messages/createdAt/updatedAt，Message 字段 id/role/content/images/reasoning/timestamp，拒绝其余字段。导入时将会话重新序列化为 data，selected_model 恢复为 value 字段，保持原插件读法。
- [x] 宿主 settings-general 使用设计文档的字段白名单；导入将这些键覆盖到本机原配置，所有非白名单字段保持原值。快捷键只选择目标 pluginName 在已安装描述符中的 canonical pluginName/command；应用路径目标留本机。
- [x] AI provider 根据稳定 provider ID 拆出本机 apiKey；运行时 getStore 继续返回组装后的原契约，导出始终使用无凭据 projection。URL 含 username/password/query 时该地址留本机，避免其中的鉴权参数被导出。新设备无密钥时模型显示待配置并拒绝调用。导入不能把空密钥抹掉本机密钥。
- [x] 新增内部 `StoredAiProvider = Omit<AiProvider, 'apiKey'>` 元数据类型，完整 AiProviderStore 只在运行 API 读取时组装。凭据设备文档为 `ZTOOLS/local-ai-provider-credentials`，由现有 ZTOOLS 默认 device 路由承接。由计划 A 升到 B 时，先持久化并读回本机凭据，再去掉旧 ai-models 中的密钥；迁移中断重试幂等，投影从第一步起始终排除凭据。不要对无 apiKey 的元数据误用旧完整 store validator 导致提供商丢失。
- [x] 适配登记仅精确版本：code-snippets 1.2.0、ai-helper 1.2.1。插件更新到未知版本保持旧同步文件和本机数据，UI 显示该版本数据未适配。
- [x] 测试：未知插件/字段/版本不导出；模板复制次数改变不改投影；AI data 包含坏 JSON 拒绝；用 `apiKey='LOCAL_ONLY_SECRET'` 断言所有共享文件都不含该配置值；正文若主动包含同字符串必须按正文处理，不把它当凭据识别通过的证据。
- [x] `pnpm exec vitest run tests/main/gitMirrorAdapters.test.ts`，通过后审查并记录；B2 保留在检查点后的工作区。

## Task B3：受限只读 Git 与稳定快照读取

**Files:** Create gitReadonly、snapshotReader；Test `tests/main/gitMirrorReader.test.ts`。

- [ ] 用临时 bare remote、两个真实 clone、linked worktree 写测试；验证 unmerged status、rebase、index.lock、HEAD 改变、坏 JSON/丢包/缺附件拒绝。
- [ ] 只读命令入口使用完整限制函数，不通过 shell：

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)

/**
 * 校验内部只读命令的固定参数形式。
 * @param args Git 子命令与参数。
 * @returns 无返回值。
 * @throws 非声明形式时抛错。
 */
function assertReadonlyArgs(args: string[]): void {
  const rev =
    args[0] === 'rev-parse' &&
    args.length === 2 &&
    ['HEAD', '--absolute-git-dir', '--git-common-dir', '--show-toplevel'].includes(args[1])
  const status = args.join('\0') === ['status', '--porcelain=v1', '-z'].join('\0')
  const files = [
    ['ls-files', '-z'],
    ['ls-files', '--stage', '-z']
  ].some((form) => args.join('\0') === form.join('\0'))
  const object =
    args[0] === 'show' &&
    args.length === 2 &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})(?::[^\0\r\n]+)?$/.test(args[1])
  if (!rev && !status && !files && !object) throw new Error('GIT_COMMAND_NOT_READONLY')
}

/**
 * 在给定工作目录执行固定的只读 Git 子命令。
 * @param executable 用户本机的 Git 可执行文件。
 * @param repoPath 本地工作目录。
 * @param args 内部构造的子命令及参数，不接受插件传入。
 * @returns stdout 文本。
 * @throws 非允许命令、超时或 Git 失败时抛错。
 */
export async function readGit(
  executable: string,
  repoPath: string,
  args: string[]
): Promise<string> {
  assertReadonlyArgs(args)
  // 固定参数边界，含空格和特殊字符的目录不会变成命令。
  const result = await execFileAsync(
    executable,
    ['--no-optional-locks', '--no-pager', '-c', 'core.fsmonitor=false', '-C', repoPath, ...args],
    {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
    }
  )
  return result.stdout
}
```

- [ ] 提供同样允许命令的二进制 reader 供 `show <oid>:<path>` 恢复包/附件，使用 Buffer 输出并单独限额；禁止把二进制经过 UTF-8 解码。OID 必须 40/64 位 hex，path 必须通过 pathSafety。
- [ ] 冲突期间用固定 `ls-files --stage -z` 解析 stage 1/2/3 的 base/local/incoming blob OID，缓存原始 Git 对象。读取 blob 使用上面已允许的固定 `show <blob-oid>` 形式；不允许任意 show 参数。这样 HEAD 尚未前进的 merge conflict 也有可恢复的 incoming 证据。
- [ ] `rev-parse --absolute-git-dir`、`rev-parse --git-common-dir` 支持 .git 为文件的 worktree；`status --porcelain=v1 -z` 检测 DD/AU/UD/UA/DU/AA/UU；读取所有 merge/rebase/index.lock 状态。不读取 Git 远端认证文件。新初始化且无提交的仓库允许 head=null；不能把其他 Git 错误都当成 unborn。测试只读检查前后 index 的内容和 mtime 不变。
- [ ] 快照返回 `{manifest, files, artifacts, head, fingerprint}`；文件 map 以相对路径为 key、以原始 bytes 和摘要为 value。稳定扫描两次间隔 200ms，HEAD、路径列表及摘要必须一致，最大重试 3 次，之后 unavailable/invalid。
- [ ] 限额建议：JSON 与最终单个 LMDB 文档各 1MiB；单 blob 10MiB；单包 100MiB；总快照 512MiB；总文件 10000，深度 64。错误报告具体相对路径，不输出内容。
- [ ] 强制验证 JSON schemaVersion、文件名与逻辑键 hash、唯一逻辑 ID、plugin/adapter、packagePath/hash、引用附件长度与摘要、平台。
- [ ] 未声明的文件不导入，不删除；未知 adapter 只跳过该插件数据并显式报告。缺少此前共享的记录且没有 tombstone 时，先核对 Git 对象：仅当记录存在于已接受基线提交而新提交明确移除了它，才能按基线身份构造逻辑删除，支持 Git 历史回退。否则标为 MISSING_RECORD，避免半完成拉取和未提交误删被当作删除；用户可在外部工具恢复或写明 tombstone。
- [ ] `pnpm exec vitest run tests/main/gitMirrorReader.test.ts`，通过后审查并提交。

## Task B4：同事务 journal 与导出确认

**Files:** Create journal；Modify `lmdb/syncApi.ts`, `lmdb/index.ts`, `storage/storageRouter.ts`；Test `tests/main/gitMirrorJournal.test.ts`。

- [ ] 在现有 LMDB 真实临时库测试：put/remove/postAttachment/removeAttachment 成功与 journal 同时出现；冲突写失败不产生 journal；device DB 的主题设置也被记录。
- [ ] journal 的最低存储合同：

```ts
export interface DirtyEntry {
  docId: string
  operation: 'put' | 'delete' | 'attachment'
  serial: number
}
export interface TransactionalJournal {
  mark(docId: string, operation: DirtyEntry['operation']): void
  list(): DirtyEntry[]
  acknowledge(docId: string, capturedSerial: number): void
  suppress<T>(operation: () => T): T
}
```

- [ ] 在每个成功的现有 LMDB transactionSync 内调用 mark，写 `_cai_git_serial` 与 `cai/git/dirty/<hash>` 的 meta 记录。mark 只为 B2 白名单对象与描述符/宿主字段记账，metadata 不公开给插件；旧 cloud changelog 不当 Git journal 使用。
- [ ] acknowledge 必须在所属 LMDB 事务内比较当前 serial==capturedSerial 才删除；导出间隙出现新修改则保留新条目。suppress 用 try/finally 计数恢复，仅启动导入时使用。
- [ ] StorageRouter 的 promises、同步与 bulk 路径必须落同一低层 transaction hook；附件 silent 路径和插件安装注册表更新也单独覆盖。禁止只靠 emit change 记账。
- [ ] 导出共享投影会读取业务文档；journal 不必复制未经筛选的凭据到共享文件。事务和本机数据已经保证待导出内容耐久，启动时可从本机最新值重新投影。
- [ ] 增加故障注入：数据提交后、异步 change 发出前终止进程；重开临时库仍能发现待导出对象。再测试旧 serial ack 不会吞掉新修改。
- [ ] `pnpm exec vitest run tests/main/gitMirrorJournal.test.ts`，通过后审查并提交。

## Task B5：原始插件包与附件传输

**Files:** Create packageArtifacts；Modify `src/main/api/renderer/pluginInstaller.ts`, `src/main/api/renderer/plugins.ts`；Test `tests/main/gitMirrorArtifacts.test.ts`。

- [ ] 在安装 ZPX/ZIP 成功但原临时包清理之前，将原程序包持久化到本机 artifacts，以 SHA-256 地址化；ZIP 按既有插件打包约定生成规范 ZPX。捕获成功后记安装描述符 journal。已装开发插件不纳入程序同步。
- [ ] 描述符使用 name/version/platform/installed/packagePath/sha256，没有本机 path、logo 绝对路径、账号、下载签名 URL。不可复用 exportAllPlugins 对运行目录的整体复制作为凭据排除保证。
- [ ] 包发布先写不可变包，再写描述符。文件名、实际 package.json/plugin.json 中 name/version/platform 一致；包 SHA256 仅表示完整性，信任来自用户选择的 Git 工作目录，不伪称作者签名。
- [ ] 归档项逐个校验：路径穿越、绝对路径、Windows ADS、symlink、大小写重复、压缩后小但展开超额全部拒绝。解包只进入临时代次，从已有安装器的预览/验证/注册流程提取不依赖 renderer 窗口的 installer core。
- [ ] 卸载描述符写 installed=false；本机凭据、未适配数据默认保留。插件主动删除业务记录产生 tombstone，删除记录不得重新复活到另一台电脑。
- [ ] 附件以 sha256 长度/type 关联，不包括 temp、剪贴板历史或浏览器 Session。来自插件自身文件的内容只有专用适配器可纳入。
- [ ] 运行 `pnpm exec vitest run tests/main/gitMirrorArtifacts.test.ts`，通过后审查并提交。

## Task B6：三方比较和自动导出保护

**Files:** Create reconcile、atomicFile、localState、exportService；Test `tests/main/gitMirrorReconcile.test.ts`, `tests/main/gitMirrorExporter.test.ts`。

- [ ] 三方规则的完整纯函数及核心测试：

```ts
export type MergeDecision = 'equal' | 'incoming' | 'local' | 'conflict'

/**
 * 比较同一逻辑对象的基线、本机和外部共享投影。
 * @param base 最后接受的基线摘要，初次为空。
 * @param local 当前本机摘要，缺失为空。
 * @param incoming 外部共享摘要，缺失为空。
 * @returns 不做时间戳猜测的合并决定。
 */
export function decideMerge(
  base: string | null,
  local: string | null,
  incoming: string | null
): MergeDecision {
  if (local === incoming) return 'equal'
  if (local === base) return 'incoming'
  if (incoming === base) return 'local'
  return 'conflict'
}
```

```ts
import { expect, test } from 'vitest'
import { decideMerge } from '../../src/main/core/gitMirror/reconcile'
test.each([
  ['b', 'b', 'r', 'incoming'],
  ['b', 'l', 'b', 'local'],
  ['b', 'l', 'l', 'equal'],
  ['b', 'l', 'r', 'conflict'],
  ['b', null, 'r', 'conflict'],
  [null, null, 'r', 'incoming']
])('三方 %s %s %s -> %s', (base, local, incoming, expected) => {
  expect(decideMerge(base, local, incoming)).toBe(expected)
})
```

- [ ] ready 状态下：捕获 dirty serial 与 projection；比较目标文件 hash 和 head 与本机 baseline；保持不变才写临时文件、flush、再校验、rename。发布后记录 baseline，再 acknowledge 捕获 serial。不能先 ack。
- [ ] 500ms 去抖、2s 最大等待、单队列；index.lock 先进入 waiting-for-git。锁解除后，内容等于本机发布基线则只更新 HEAD/checkpoint 并继续 ready，正常 add/commit 不要求重启。实际外部内容变化、unmerged、读取失败才进入对应暂停状态。自己发布产生的 watcher 事件按 hash+serial 消除，不按粗略时间窗口跳过。暂停状态的 mark 继续持久化，但 exporter 不写共享文件。
- [ ] atomicFile 禁止使用“先删旧文件、再 rename”的发布方式；Windows rename 失败保留旧文件和 journal，报告 EXPORT_FAILED。临时文件只能在明确的该目录下创建/清理，禁止跨 shell 递归删除。
- [ ] 保存共享投影 base 与 external 证据；读取 Git HEAD 的 immutable objects 作为竞态恢复来源。若目标 hash 与提交对象/本机基线产生无法解释的偏差，将其作为 conflict，不能自动覆盖。
- [ ] 外部冲突材料包含三版本和摘要、相对路径；用户在外部工具解决后，应用接受以下两类可判定输入：工作目录已明确选择 local/incoming 版本，或用户在设置页点击“已在外部解决”后登记该文件的新 hash。该按钮仅确认外部结果，不提供应用内合并。
- [ ] 集成测试用屏障让真实 Git pull 分别发生在导出校验前、临时文件 flush 后、rename 前后，断言本机修改与 Git 已提交内容都能被恢复，无法判定就冲突。仅 watcher 命中率不是验收证据。
- [ ] 停止导出时等待当前任务回收；退出只有 ready 才 flush，任何暂停状态都只落本机 journal，不把旧值写回拉取后的文件。
- [ ] `pnpm exec vitest run tests/main/gitMirrorReconcile.test.ts tests/main/gitMirrorExporter.test.ts`，通过后审查并提交。

## Task B7：启动前构造新代次并原子切换

**Files:** Create generationStore、bootstrap；Modify appDataPaths、index、appMain、windowManager、storageManager；Test `tests/main/gitMirrorImport.test.ts`。

- [ ] 明确启动 orchestration 的完整端口；端口实现分别落 reader/reconcile/generationStore/localState，不导入业务单例：

```ts
export interface PreparedGeneration {
  id: string
  previous: string
}
export interface BootstrapPorts {
  hasConfiguredRepo(): boolean
  readAndValidateIncoming(): Promise<void>
  reconcileLocal(): Promise<'ok' | 'conflict'>
  buildGeneration(): Promise<PreparedGeneration>
  verifyGeneration(generation: PreparedGeneration): Promise<void>
  publishPointer(generation: PreparedGeneration): Promise<void>
  discardUnpublished(generation: PreparedGeneration): Promise<void>
  recordIssue(error: unknown): Promise<void>
}

/**
 * 在业务模块加载前准备完整的本机数据代次。
 * @param ports 分阶段实现的低层文件、数据库和校验操作。
 * @returns prepared、local 或 conflict 状态。
 */
export async function prepareGitMirror(
  ports: BootstrapPorts
): Promise<'prepared' | 'local' | 'conflict'> {
  let generation: PreparedGeneration | null = null
  try {
    if (!ports.hasConfiguredRepo()) return 'local'
    // 输入全部校验通过后，才允许接触候选代次。
    await ports.readAndValidateIncoming()
    if ((await ports.reconcileLocal()) === 'conflict') return 'conflict'
    generation = await ports.buildGeneration()
    await ports.verifyGeneration(generation)
    // 只切换一个指针，DB 与插件路径共同选择新代次。
    await ports.publishPointer(generation)
    return 'prepared'
  } catch (error) {
    // 未发布的候选可以清理，现有生效代次保持可用。
    if (generation) {
      try {
        await ports.discardUnpublished(generation)
      } catch {
        console.warn('GIT_MIRROR_CANDIDATE_CLEANUP_FAILED')
      }
    }
    try {
      await ports.recordIssue(error)
    } catch {
      console.warn('GIT_MIRROR_ISSUE_RECORD_FAILED')
    }
    return 'local'
  }
}
```

publishPointer 是最后发布点：失败时必须保证未发布，或由本机 preparation transaction 恢复；discardUnpublished 不得删除已经成为 active 的代次。清理自身失败同样记录为 issue，但不能阻止本机启动。

- [ ] appDataPaths 增加 getActiveGenerationRoot，所有数据库/插件/插件数据路径选择该代次；clipboard、log、temp 留根目录。读取与写 active-generation.json 只在受控启动/回退代码中发生。
- [ ] 从计划 A 升级时，如果尚无 active 指针但 `.cai-tools/lmdb` 已有本地版数据，先离线读取并关闭原库，复制本地版自己的数据库/插件/插件数据到首个代次，重建注册路径，验证后发布指针。失败保持原本地版布局与内容。这个升级步骤只处理 `.cai-tools`，不会读取原版 `.ztools`；不能因引入代次目录而创建空库丢掉阶段 A 的数据。
- [ ] index 取得锁后动态调用 bootstrap，然后才 `import('./appMain')`。appMain 的 GPU 读取、ClipboardManager singleton、API 初始化与插件自动启动全在导入完成后。windowManager 新增受控初期隐藏能力，完成关键初始化并标记 accepted 之后才暴露可交互窗口/自动启动用户插件。此前失败按 transaction 回退；accepted 后的进程崩溃保留当前代次与 journal，不能回退丢掉新的用户修改。
- [ ] 构建候选：离线打开旧 DB 读取/投影、关闭；复制旧代次，使用 suppress 导入合并值。保留本机凭据、未适配记录和环境字段，重建本机插件注册路径；逐一检查 put/remove 返回 ok。
- [ ] 多 DB 与插件安装不是一个 LMDB 事务，所以全部变更先在候选目录完成；禁止对生效目录逐文件覆盖后声称具有整体回滚。
- [ ] 验证所有文档、附件、包和 registry；原子发布 active-generation.json 后保留旧代次。接受新代次后再保留最近 3 代并清理，所有路径必须 realpath 验证归属本机根。
- [ ] 故障矩阵：JSON 解析、附件摘要、归档解包、第二个 DB put、文件复制、pointer 临时写、pointer 发布、业务启动就绪前分别失败。验证老数据/凭据/插件仍可用，无半套新数据；中途强制终止后重启能恢复。
- [ ] `pnpm exec vitest run tests/main/gitMirrorImport.test.ts`，通过后审查并提交。

## Task B8：设置页、目录绑定与状态 IPC

**Files:** Create renderer/gitMirror、GitMirrorSetting；Modify router、resources/preload、main preload、env.d.ts、api/index、appMain；Test `tests/main/gitMirrorIpc.test.ts`。

- [ ] 固定 IPC：`git-mirror:get-status`、`git-mirror:choose-directory`、`git-mirror:open-directory`、`git-mirror:open-conflicts`、`git-mirror:accept-external-resolution`、`git-mirror:request-restart`，以及推送 `git-mirror:status-changed`。目录通过主进程系统对话框选择，开目录只使用已验证配置，不接受任意 renderer path。
- [ ] 使用现有 requireInternalPlugin 检查 sender；事件 listener 返回释放函数，页面退出释放，status payload 不含正文、密钥或用户文件内容。
- [ ] 配置保存到本机 profile-settings.json。选择空工作目录时初始化 profile；选择有效非空快照时暂停导出、提示重启，不先把当前空 DB 导出覆盖它。选择其他 profileId 视为换工作环境，先保存本机代次并给明确信息。
- [ ] 首次无 Git 目录照常启动；配置目录丢失时状态 unavailable，本机功能可用。停用同步只停止 exporter，不删除 repo 和本机数据。
- [ ] 页面正文测试标识：git-mirror-root、git-mirror-status、git-mirror-adapters、git-mirror-restart、git-mirror-conflict-folder、git-mirror-resolution-confirm。范围表分别显示“程序可同步”和“数据已适配/留本机”。
- [ ] 重启动作通过 app.relaunch + windowManager 的受控退出标志；退出前遵守暂停状态 flush 规则，不在退出回调里重写 incoming。
- [ ] `pnpm exec vitest run tests/main/gitMirrorIpc.test.ts`，通过后审查并提交。

## Task B9：真实样本插件与双实例 Git 验收

**Files:** Create `tests/e2e/git-mirror.spec.ts`, `tests/e2e/helpers/gitFixture.ts`, `tests/e2e/fixtures/git-mirror/`；记录到 `docs/superpowers/plans/evidence/git-mirror-acceptance.md`。

- [ ] 固定源码样本来自插件仓库 e4962a0a44d2cc50bdb1c2f85577e8525e6bf040：code-snippets 1.2.0、ai-helper 1.2.1。实际构建样本需安装它们声明的依赖，记录包 hash 和清单。测试 fixture 带来源、版本及许可证；最小伪插件只能用于故障注入，不能代替真实插件兼容验收。
- [ ] helper 为临时 bare remote 与 A/B clone 创建真实 Git 流程；测试专用 user.name/email 仅在临时仓库的 local config，真实账户配置不动。实际 Git 操作由测试端运行，应用端仅只读查询。
- [ ] 使用源码项目作为 Electron args；A/B 都传各自临时 ZTOOLS_DATA_ROOT、临时旧目录和 15177 设置开发服务。多实例若受锁限制，测试专用隔离 userData 下启动或依次运行；必须额外保留至少一个两实例同时运行场景验证运行中拉取保护。
- [ ] A UI 安装并打开真实模板插件、创建/修改/删除模板；等稳定导出，外部 commit/push；B pull 后重启，模板和插件版本一致，B 本机密钥不变。
- [ ] B 修改另一条数据后外部 push，A 在运行中 pull，确认暂停和重启提示；重启读到 B 内容；主题与插件快捷键恢复，本机路径和位置保持原值。
- [ ] 同一条内容 A/B 分别修改，制造真实 Git 冲突；应用保留本机内容，打开三份材料；外部修正文件并确认解决后重启可用。验证 pending journal 没有被误清除。
- [ ] 用 mock 本机 AI endpoint 验证真实 AI 助手能读取/写入会话，A/B 会话恢复且密钥仅本机。此检查不调用收费模型。
- [ ] 插件版本不适配、目录缺失、格式未来版本、Git rate/网络离线、磁盘写失败、应用异常退出都验证本机可继续使用。重启前 late write 单独故障注入。
- [ ] 截图只取插件 WebContentsView，正文中出现模板名称/会话消息后截图，保存 test-results/playwright；测试 trace 不入 Git。
- [ ] `pnpm typecheck`、`pnpm --dir internal-plugins/setting exec vue-tsc --noEmit`、`pnpm test`、`pnpm test:e2e`。同样不运行任何打包命令。

## 验收编号与责任映射

| 编号 | 验收行为                                                | 任务        |
| ---- | ------------------------------------------------------- | ----------- |
| G01  | 空 profile 无账号启动，未选目录仍可用                   | A1/A2/B8    |
| G02  | 同步目录与真实 .ztools 分离                             | A1/B1       |
| G03  | 外部 Git 完成全部修改型操作，应用不持有托管平台账号     | B3/B8/B9    |
| G04  | 宿主通用字段导出，环境和凭据保留                        | B2/B7/B9    |
| G05  | 程序版本与包能在新机恢复                                | B5/B7/B9    |
| G06  | 未适配插件的程序可用、数据保持本机                      | B2/B8/B9    |
| G07  | 两个真实适配插件的数据可迁移                            | B2/B9       |
| G08  | 明确 tombstone 传播，意外缺文件不删数据                 | B3/B4/B9    |
| G09  | 运行中真实 pull 后暂停导出，重启加载                    | B6/B7/B9    |
| G10  | 拉取/导出竞态保留本机 journal 与 Git immutable incoming | B4/B6/B9    |
| G11  | 多端同对象冲突保存三版本，外部解决后恢复                | B6/B8/B9    |
| G12  | 损坏/缺附件/解包失败不切换生效代次                      | B1/B3/B5/B7 |
| G13  | 每个发布阶段被终止后可回退                              | B7/B9       |
| G14  | 同样投影不重写，无复制次数噪声                          | B1/B2/B6    |
| G15  | 无账号心跳、无自动原版升级的普通运行实测                | A6          |
| G16  | 匿名下载实际安装与主动更新提醒分别验证                  | A3/A4/A6    |

全部要求满足并有对应实际证据后才标为完成。实际 Git 文件合并成功，不代表插件业务数据已经完成一致性验证；严格 snapshot 校验和三方规则必须一并通过。
