# CAI.Tools 免登录本地版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task when delegated execution is chosen. Steps use checkbox (`- [ ]`) syntax for tracking. Inline execution follows the same tasks and checks.

**Goal:** 交付 Windows 上打开即用、独立数据目录、保留 ZTools 插件 API 和匿名市场的本地版。

**Architecture:** 复用 default LMDB 空间，移除运行入口中的官方账号服务与后台心跳。用本地能力响应替代官方用户、支付、云同步 API；主程序更新替换为主动的上游版本提醒。Git 同步作为第二个独立计划接入。

**Tech Stack:** Electron 41.4.0、Vue 3、TypeScript、LMDB、Vitest、Playwright Electron。

---

开始日期：2026-10-14；整理完成：2026-10-15。实施基线为 `6c9dee8`。上位规格：[具体设计](./2026-10-14-cai-tools-git-local-design.md)。本文命令的预期结果是验收目标，不是已运行结果。

执行结果（2026-10-15）：A0–A6 已完成实施与本机验收收尾，实际结果及限制见[验收记录](./evidence/local-edition-acceptance.md)。下方清单保留原计划契约；完整设置页面仍有 22 项基线类型错误，上游实查返回 HTTP 403 / unavailable，不将这些项目记作全通过。计划 B 尚未开始。

## 文件结构和执行约束

| 文件                                                                     | 操作与责任                                                        |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `src/shared/localEdition.ts`                                             | 新建：产品标识、上游基线和不可用能力结果。                        |
| `src/main/core/appData/appDataPaths.ts`                                  | 修改：独立默认根目录，保持隔离测试覆盖参数。                      |
| `src/main/core/storage/storageManager.ts`                                | 修改：本地版固定 default 数据空间，不恢复官方 uid。               |
| `src/main/index.ts`、`src/main/appMain.ts`                               | 修改：新应用身份、无旧数据导入、无活动心跳。                      |
| `src/main/api/index.ts`                                                  | 修改：注册本地替代 API，不初始化官方同步和原版更新器。            |
| `src/main/api/plugin/internal.ts`                                        | 修改：替换官方通知处理器及其导入，把更新调用改为本地提醒 facade。 |
| `src/main/api/plugin/localUserCapabilities.ts`                           | 新建：保持用户/支付 API 入口，返回明确不可用。                    |
| `src/main/api/renderer/localCapabilities.ts`                             | 新建：官方账号、云同步和旧迁移 IPC 的明确不可用响应。             |
| `src/main/api/renderer/pluginMarketConfig.ts`                            | 修改：匿名请求，取消凭据加载、刷新和保存。                        |
| `src/main/api/plugin/ai.ts`、`src/main/api/renderer/aiModels.ts`         | 修改：只使用自配提供商，官方功能返回不可用。                      |
| `src/main/core/localEdition/upstreamUpdateNotice.ts`                     | 新建：主动、只读的上游版本提醒。                                  |
| `src/main/api/localUpdater.ts`                                           | 新建：提醒 IPC 和旧更新 IPC 的兼容响应。                          |
| `internal-plugins/setting/src/components/LeftMenu/LeftMenu.vue`          | 修改：本地身份信息，不挂载账号、通知 composable。                 |
| `internal-plugins/setting/src/router/router.ts`                          | 修改：移除账号、消息和云同步路由，保留本机功能。                  |
| `internal-plugins/setting/src/components/common/PluginDetail/*`          | 修改：取消评论编辑、点赞和登录弹窗，保留安装、介绍、版本。        |
| `internal-plugins/setting/src/views/AiModelsSetting/AiModelsSetting.vue` | 修改：保留自配提供商，移除官方余额/充值/模型加载。                |
| `internal-plugins/setting/src/views/AboutSetting/AboutSetting.vue`       | 修改：显示上游基线和主动检查结果。                                |
| `internal-plugins/setting/src/views/GeneralSetting/GeneralSetting.vue`   | 修改：移除主程序自动检查开关及其调用。                            |
| `resources/preload.js`、`src/preload/index.ts`、设置页 `env.d.ts`        | 修改：新增本地能力/版本提醒类型；保留既有插件 API 名称。          |
| `package.json`、`electron-builder.yml`                                   | 修改：产品身份和手动发布元信息；本阶段验证不打包。                |
| `pnpm-workspace.yaml`                                                    | 新建：pnpm 11 构建脚本许可与现有双 lockfile 布局。                |

所有新增/实质修改方法遵守根 AGENTS.md 的 JSDoc 和步骤注释规范。首次实施时检查干净工作树和当前基线，需要隔离时使用 using-git-worktrees 技能；使用返回的真实路径执行任务。每个任务单独审查、按需提交，不推送或发布。

### Task A0：准备当前 Windows 开发环境

**Files:** Create `pnpm-workspace.yaml`; Modify `package.json` 的已失效 pnpm 配置块；保留根和设置插件现有 pnpm-lock.yaml。

- [ ] 当前只读检测结果：Git 2.55.0.windows.4、Node 22.19.0、pnpm 11.18.0，依赖与子模块均未准备。先执行 `git submodule update --init --recursive`，确认 ztools-api-types 和 ztools-plugin-cli 的 package.json 存在。
- [ ] 为 pnpm 11 创建以下完整配置，保留现有两个 lockfile，删除 package.json 中被忽略的 onlyBuiltDependencies 块。不要降级 pnpm 或开启全部依赖构建：

```yaml
packages:
  - internal-plugins/setting
sharedWorkspaceLockfile: false
allowBuilds:
  electron: true
  esbuild: true
  lmdb: true
  msgpackr-extract: true
  uiohook-napi: true
  less: true
```

依据：[pnpm 官方 allowBuilds 配置](https://pnpm.io/settings/build#allowbuilds)。如安装报告额外未声明的构建脚本，先核对实际依赖来源和脚本，再逐项添加，不用全局放行代替判断。

- [ ] 执行 `pnpm install --frozen-lockfile`。由于 workspace 包已包含设置插件，统一安装两者，同时保留各自 lockfile。如果 frozen 检查因 workspace 元信息不同失败，只修正需要的锁文件元信息，审查依赖 diff，禁止不相关版本升级。
- [ ] 如安装前已经存在被阻止的原生包，执行 `pnpm rebuild electron esbuild lmdb msgpackr-extract uiohook-napi less`。
- [ ] `pnpm exec electron --version` 应输出 v41.4.0；`pnpm typecheck` 和 `pnpm --dir internal-plugins/setting exec vue-tsc --noEmit` 确认可编译基线。这里是未来实施准备检查，本轮仅已读取环境版本。
- [ ] 审查只涉及依赖许可和 workspace 布局的改动，按需提交，再开始 A1。

### Task A1：建立本地产品身份与独立数据根

**Files:** Create `src/shared/localEdition.ts`; Modify `src/main/core/appData/appDataPaths.ts`, `src/main/core/storage/storageManager.ts`, `src/main/index.ts`, `package.json`, `electron-builder.yml`; Test `tests/main/localEdition.test.ts`。

- [ ] 写测试：默认根是临时 home 下 `.cai-tools`；options.dataRoot 和 ZTOOLS_DATA_ROOT 的优先级不变；旧 `.ztools` 不被读取；既有 uid 不切换 default 空间。
- [ ] `pnpm exec vitest run tests/main/localEdition.test.ts`，新断言应先失败。
- [ ] 新增完整产品常量与错误合同：

```ts
export const LOCAL_PRODUCT_NAME = 'CAI.Tools'
export const LOCAL_APP_ID = 'tools.cai.local'
export const UPSTREAM_BASE_VERSION = '3.2.0'
export const LOCAL_DEFAULT_ROOT_NAME = '.cai-tools'

/**
 * 返回本地版不提供的官方服务能力结果。
 * @param capability 被调用的官方能力名。
 * @returns 可供 IPC 传递的明确失败结果。
 */
export function unavailableOfficialCapability(capability: string) {
  // 稳定错误码供插件判断能力，消息不包含令牌或数据内容。
  return {
    success: false as const,
    code: 'OFFICIAL_CAPABILITY_UNAVAILABLE' as const,
    error: `当前本地版不提供官方服务能力：${capability}`
  }
}
```

- [ ] `getZToolsRoot` 的最终回退改用 LOCAL_DEFAULT_ROOT_NAME；显式路径覆盖保持原签名。storageManager.init 将 currentAccountUid 固定 null，accountPathForUid 选择 default；switchAccount 非空 uid 返回明确不可用错误。不删除任何旧目录。
- [ ] index 顶部设置 `app.setName(LOCAL_PRODUCT_NAME)` 和 Windows AppUserModelId=LOCAL_APP_ID；package description/productName/executableName 使用 CAI.Tools；builder appId 修改，移除指向官方仓库的 publish 配置，版本保留上游基线另加本地构建标记。
- [ ] 为测试创建一个伪 uid 的 device DB，关闭后再 init，确认读取 default 且伪 uid 目录没有新增业务写入。
- [ ] 重跑上述测试，通过后审查并提交这一任务。

### Task A2：清理启动链路，保留插件接口形状

**Files:** Modify `src/main/appMain.ts`, `src/main/api/index.ts`, `src/main/api/plugin/internal.ts`; Create `src/main/api/plugin/localUserCapabilities.ts`, `src/main/api/renderer/localCapabilities.ts`; Modify `src/main/api/renderer/storage.ts`; Test `tests/main/localCapabilities.test.ts`。

- [ ] 写测试：getUser 为 null；官方 token/支付调用明确失败且没有 HTTP；账号 IPC 失败但本机 DB 可正常写；启动不实例化官方心跳/同步客户端。
- [ ] `pnpm exec vitest run tests/main/localCapabilities.test.ts`，确认测试捕获原来的官方服务路径。
- [ ] 本地替代插件入口使用下列完整注册函数，替换 api/index 中 pluginUserAPI、pluginPaymentAPI 的初始化及导入：

```ts
import { registerPluginApiServices } from './pluginApiDispatcher'

/**
 * 拒绝依赖官方身份的插件调用。
 * @returns 永不正常返回。
 * @throws 本地版不提供官方服务时抛出错误。
 */
function rejectOfficialCapability(): never {
  // 保持异步 IPC 的失败语义，避免返回伪造身份。
  throw new Error('OFFICIAL_CAPABILITY_UNAVAILABLE')
}

/**
 * 注册本地版的用户和支付兼容入口。
 * @returns 无返回值。
 */
export function registerLocalUserCapabilities(): void {
  // 无账号资料时保持现有 getUser 的 null 语义。
  registerPluginApiServices({
    /**
     * 返回本地版的无官方账号状态。
     * @param event 插件同步调用事件。
     * @returns 无返回值。
     */
    getUser(event: Electron.IpcMainEvent) {
      event.returnValue = null
    },
    getUserTempToken: rejectOfficialCapability,
    requestPayment: rejectOfficialCapability,
    getPaymentRecords: rejectOfficialCapability
  })
}
```

代码中拒绝方法适配 dispatcher 的异步/同步注册元信息，不能改变调用模式。

- [ ] 收集 `sync.ts` 的所有 `ipcMain.handle/on` 通道以及资源 preload 中官方账号、同步调用；生成确定的通道列表，在 localCapabilities 内注册 `{success:false,code,error}`，只读 session 返回 null。保留 internal-plugin sender 校验，不把旧账号 API 删除成无响应调用。
- [ ] `src/main/api/plugin/internal.ts` 还有独立注册的官方通知 summary/list/markRead/markAllRead/archive handlers。原位置替换为不可用响应并移除 notificationsAPI import；不在第二个模块重复注册同名通道。
- [ ] appMain 移除 heartbeat import/start/stop 和 firstRunStorageImport 调用；storage API 不检测真实旧路径，旧迁移入口返回明确失败。HTTP/MCP 的本机功能遵循原本开关，不因去账号而新增监听器。
- [ ] 主程序入口取消 syncAPI.init、官方账号/通知导入、原版 updater 初始化。通过 import 图检查真实运行可达链，不以 UI 隐藏作为完成条件。
- [ ] 重跑 A1+A2 测试，通过后审查并提交。

### Task A3：匿名插件市场与自配 AI

**Files:** Modify `src/main/api/renderer/pluginMarketConfig.ts`, `src/main/api/plugin/ai.ts`, `src/main/api/renderer/aiModels.ts`; Test `tests/main/pluginMarketConfig.test.ts`, `tests/main/localAiCapabilities.test.ts`。

- [ ] 在现有市场测试中更新本地版预期：不读 official session；不刷新 token；去掉调用方 Authorization；401 返回有意义的错误，不弹登录。
- [ ] 完整替换 requestPluginMarket 的本地请求体；沿用已有 HttpRequestOptions/HttpResponse/httpRequest 类型和 helper 导入：

```ts
/**
 * 执行匿名市场请求，账号操作在网络访问前失败。
 * @param path 市场相对路径或明确的完整地址。
 * @param options 原有 HTTP 请求选项。
 * @param authMode 调用方声明的账号要求。
 * @returns HTTP 成功响应。
 * @throws 账号操作或非成功 HTTP 状态时抛错。
 */
export async function requestPluginMarket(
  path: string,
  options: HttpRequestOptions = {},
  authMode: PluginMarketAuthMode = PluginMarketAuthMode.OPTIONAL
): Promise<HttpResponse> {
  if (authMode === PluginMarketAuthMode.REQUIRED)
    throw new PluginMarketAuthRequiredError('此操作需要官方账号，本地版不提供')
  // 删除外部传入的鉴权头，避免残留凭据进入匿名请求。
  const headers = Object.fromEntries(
    Object.entries(options.headers || {}).filter(([name]) => name.toLowerCase() !== 'authorization')
  )
  const url = path.startsWith('http') ? path : `${getPluginMarketApiBase()}${path}`
  const response = await httpRequest(url, {
    ...options,
    headers,
    validateStatus: (status) => status >= 200 && status < 300
  })
  return response
}
```

getPluginMarketAuthHeaders 返回空对象；savePluginMarketTokens 抛 OFFICIAL_CAPABILITY_UNAVAILABLE；删除其官方 account service 静态导入及 refresh helper。外部 mercado 自带 downloadUrl 的既有支持保持可用。

- [ ] AI getAllAiModels 完整返回 `aiProviderService.getModelChoices()`；getModelConfig 完整返回 `aiProviderService.resolveModel(modelRef)`；移除 officialAIService import。aiModels renderer API 的官方查询/充值入口返回不可用，本机提供商 CRUD 不变。
- [ ] 用 mock 提供商验证真实插件调用仍能选择本机模型；无码钥时给配置提示，不回退官方服务。401、403、429、超时均可退出请求，不重试登录。
- [ ] 运行 `pnpm exec vitest run tests/main/pluginMarketConfig.test.ts tests/main/pluginMarketLatest.test.ts tests/main/localAiCapabilities.test.ts tests/main/aiProviderService.test.ts`，通过后审查并提交。

### Task A4：用主动提醒替换主程序更新器

**Files:** Create `src/main/core/localEdition/upstreamUpdateNotice.ts`, `src/main/api/localUpdater.ts`; Modify `src/main/api/index.ts`, `src/main/appMain.ts`, `src/main/api/plugin/internal.ts`; Test `tests/main/upstreamUpdateNotice.test.ts`。

- [ ] 测试主动请求之前 fetch 调用次数为 0；主动检查可返回新版本；率限/超时返回 unavailable；任意旧安装 IPC 都失败。
- [ ] 实现完整稳定版本比较函数，供本机版本与 GitHub stable release 比较：

```ts
/**
 * 解析稳定三段版本号。
 * @param value 可带 v 前缀的稳定版本号。
 * @returns 三个安全整数版本分量。
 * @throws 格式或数值超出范围时抛错。
 */
function parseStableVersion(value: string): number[] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (!match) throw new Error('INVALID_STABLE_VERSION')
  const parts = match.slice(1).map(Number)
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new Error('INVALID_STABLE_VERSION')
  return parts
}

/**
 * 比较两个稳定三段版本号。
 * @param candidate 候选版本，可带 v 前缀。
 * @param baseline 上游基线版本。
 * @returns 候选版本更新时返回 true。
 * @throws 非稳定三段版本号时抛错。
 */
export function isNewerStableVersion(candidate: string, baseline: string): boolean {
  // 严格解析，避免把本地构建标记当上游版本排序。
  const next = parseStableVersion(candidate),
    current = parseStableVersion(baseline)
  for (let index = 0; index < 3; index++) {
    if (next[index] !== current[index]) return next[index] > current[index]
  }
  return false
}
```

外层检查函数只访问 `https://api.github.com/repos/ZToolsCenter/ZTools/releases/latest`，AbortSignal.timeout(10000)，读取 tag_name/html_url，比较 UPSTREAM_BASE_VERSION；不取下载源、不实例化 platform updater。

- [ ] localUpdater 仅在用户 IPC 后执行检查，结果类型：`{kind:'up-to-date'|'available'|'unavailable', version?:string, releaseUrl?:string, message?:string}`。所有旧 updater:start-update/install-downloaded-update/quit-and-install 通道返回明确不可用；get-download-status 返回 idle，cleanup 为无资源结束。
- [ ] appMain、APIManager 和 plugin/internal 的 updater import 全部指向 localUpdater，避免 internal handler 绕过新策略。facade 保留 checkUpdate/startUpdate/setAutoCheck/cleanup 签名：checkUpdate 转为旧 `{success,updateAvailable,updateInfo?,error?}` 包装；startUpdate 返回不可用；setAutoCheck 始终保持关闭且不创建 timer；cleanup 无资源结束。
- [ ] 只允许打开 GitHub 指定仓库的 release 页面；不把服务响应中的任意 URL 交给 shell.openExternal。
- [ ] `pnpm exec vitest run tests/main/upstreamUpdateNotice.test.ts`，通过后审查并提交。

### Task A5：收敛设置与市场界面

**Files:** Modify 左侧菜单、router、PluginDetail、AiModelsSetting、AboutSetting、GeneralSetting、preload 和 env.d.ts；Test `tests/e2e/local-edition.spec.ts`。

- [ ] 用现有 UI 组件修改菜单：本地工作台名称；取消 useAccountProfile/useNotificationCenter/useZToolsAccount 的挂载调用、监听和弹窗；路由中账号/消息/云同步直达也重定向通用设置。
- [ ] 插件详情 tabs 删除 comments 与相关写操作按钮，保留文档/安装/版本/数据。AI 页面只加载自配供应商；关于页以 local-edition:check-upstream 返回结果呈现主动提醒，不展示原版安装按钮。
- [ ] 新 IPC 的 renderer 声明采用一致合同：

```ts
export interface LocalEditionInfo {
  product: 'CAI.Tools'
  upstreamBase: string
  officialAccount: false
  cloudSync: false
}
export interface UpstreamNotice {
  kind: 'up-to-date' | 'available' | 'unavailable'
  version?: string
  releaseUrl?: string
  message?: string
}
```

- [ ] 核对所有修改函数的 JSDoc 参数和返回值，移除已与本地版行为不符的官方账号说明。
- [ ] 单独截图插件 WebContentsView；等待“开机自动启动”或新页面正文的稳定特征，不用侧栏标题判定加载完成。
- [ ] 审查并提交此任务；E2E 在 A6 统一构建源码后执行。

### Task A6：源码 Electron 与普通运行验收

**Files:** Create `tests/e2e/local-edition.spec.ts`, `tests/main/localRuntimeNetwork.test.ts`; Modify `tests/e2e/private-sync.spec.ts` 的适用性声明；记录到 `docs/superpowers/plans/evidence/local-edition-acceptance.md`。

- [ ] E2E 使用现有 `tests/e2e/ztools.spec.ts` 的 launch 与临时目录清理方式，两个根均隔离。核心环境必须原样具备：

```ts
const launchEnv = {
  ...process.env,
  ZTOOLS_DATA_ROOT: temporaryProfile,
  ZTOOLS_LEGACY_USER_DATA_PATH: temporaryLegacy,
  ZTOOLS_E2E: '1',
  ZTOOLS_SETTING_DEV_SERVER_URL: 'http://127.0.0.1:15177'
}
```

temporaryProfile 和 temporaryLegacy 都由 fs.mkdtemp / path.join 创建，不能引用真实 home。原 private-sync 专项覆盖的功能已移除，应明确标记上游模式不适用，保留原因与新测试映射，不能伪称旧流程通过。

- [ ] 验证首次无账号启动、插件安装打开、db/dbStorage/附件、主题快捷键、自配 AI，以及账号/支付调用稳定失败。
- [ ] `pnpm typecheck`、`pnpm --dir internal-plugins/setting exec vue-tsc --noEmit`、`pnpm test`、`pnpm test:e2e`。按失败修改对应代码，再重跑受影响检查。
- [ ] 若本机首次应用扫描触发超时，按实际日志增加专项 E2E 的 timeout=120000、expect.timeout=60000；仍等待正文稳定特征，不削弱断言。
- [ ] 额外用源码 Electron 在不设置 ZTOOLS_E2E 的情况下启动临时 profile；观察至少 35 分钟，覆盖原半小时心跳/自动更新周期。主程序和设置页主动操作前没有官方账号、通知、心跳、自动更新请求；主动市场/版本检查可联网；插件自身主动联网按功能记录。
- [ ] 匿名市场真实获取一个样本并安装、打开；HTTP 元数据可访问与真实安装成功分别记录。
- [ ] 本阶段不执行 electron-builder、build:unpack 或任何安装包测试。检查真实 `.ztools` 未被改写，日志中没有正文凭据。填入实际命令退出码、截图与故障证据，不填预计通过数。

## 交付条件

R01、R02、R10、R11 的本机部分可独立验收；插件兼容保留、自配提供商和主程序提醒也有实测证据后，进入计划 B。任何未验证点保留为明确限制。源码检查结果不能替代正常运行网络审计。
