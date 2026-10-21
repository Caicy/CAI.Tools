<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useDialogs } from './dialogs'
import {
  CONTEXT_MENU_KIND_LABELS,
  CONTEXT_MENU_LOCATIONS,
  CONTEXT_MENU_STATE_LABELS,
  supportsState,
  type ContextMenuBackup,
  type ContextMenuEnvironment,
  type ContextMenuResult,
  type ContextMenuState,
  type WindowsContextMenuEntry
} from '@shared/windowsContextMenu'

interface EntryGroup {
  name: string
  items: WindowsContextMenuEntry[]
  system: boolean
  changed: number
}

const STATES: ContextMenuState[] = ['shown', 'extended', 'disabled']
const STATUS_TEXT: Record<ContextMenuState, string> = {
  shown: '显示中',
  extended: '仅 Shift',
  disabled: '已禁用'
}
const ACTION_TEXT: Record<ContextMenuState, string> = {
  shown: '显示',
  extended: '设为仅 Shift 显示',
  disabled: '禁用'
}
const RECORD_STATE_TEXT: Record<string, string> = {
  shown: '显示',
  extended: '仅 Shift',
  disabled: '禁用',
  on: '开启',
  off: '关闭'
}

const { confirm, success, error, finish, dialog, notice } = useDialogs()
const supported = ref(window.ztools.internal.getPlatform() === 'win32')
const entries = ref<WindowsContextMenuEntry[]>([])
const environment = ref<ContextMenuEnvironment | null>(null)
const busy = ref(false)
const loaded = ref(false)
const query = ref('')
const kind = ref('')
const scope = ref('')
const state = ref('')
const source = ref('')
const grouped = ref(true)
const selected = ref(new Set<string>())
const loadError = ref('')
const listWarnings = ref<string[]>([])
const historyError = ref('')
const backups = ref<ContextMenuBackup[]>([])
const needsRestart = ref(false)
const historySection = ref<HTMLElement | null>(null)

// 读取失败或记录损坏时禁止基于旧数据写入；后端也会再次拒绝。
const writeLocked = computed(() => busy.value || !!loadError.value || !!historyError.value)
const filtered = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return entries.value.filter(
    (entry) =>
      (!kind.value || entry.kind === kind.value) &&
      (!scope.value || entry.locations.includes(scope.value)) &&
      (!state.value || entry.state === state.value) &&
      (!source.value || (source.value === 'system') === entry.system) &&
      (!keyword ||
        `${entry.name} ${entry.group} ${entry.command} ${entry.id}`.toLowerCase().includes(keyword))
  )
})
const groups = computed<EntryGroup[]>(() => {
  const map = new Map<string, WindowsContextMenuEntry[]>()
  for (const entry of filtered.value) {
    const name = grouped.value ? entry.group : '全部菜单项'
    map.set(name, [...(map.get(name) || []), entry])
  }
  // 第三方程序排在前面，系统组件放到最后，降低误操作概率。
  return [...map.entries()]
    .map(([name, items]) => ({
      name,
      items,
      system: items.every((item) => item.system),
      changed: items.filter((item) => item.state !== 'shown').length
    }))
    .sort((a, b) => Number(a.system) - Number(b.system) || a.name.localeCompare(b.name, 'zh-CN'))
})
const selectedEntries = computed(() =>
  entries.value.filter((entry) => selected.value.has(entry.id))
)
const bulkCandidates = computed(() =>
  filtered.value.filter(
    (entry) => isSelectable(entry) && (source.value === 'system' || !entry.system)
  )
)
const allSelected = computed(
  () =>
    bulkCandidates.value.length > 0 &&
    bulkCandidates.value.every((entry) => selected.value.has(entry.id))
)
const restorable = computed(() => backups.value.filter((backup) => backup.canRestore))

/**
 * 判断修改该项是否需要管理员权限且当前未提权。
 * @param entry 菜单项
 * @returns 是否因权限不足只读
 */
function adminOnly(entry: WindowsContextMenuEntry): boolean {
  if (environment.value?.isAdmin) return false
  return (entry.kind === 'verb' && entry.hive === 'HKLM') || !!entry.blockedBy?.includes('HKLM')
}

/**
 * 判断菜单项能否加入批量选择。
 * @param entry 菜单项
 * @returns 是否可选
 */
function isSelectable(entry: WindowsContextMenuEntry): boolean {
  return !adminOnly(entry)
}

/**
 * 生成位置说明；文件类型较多时折叠显示。
 * @param entry 菜单项
 * @returns 可读的位置文本
 */
function locationText(entry: WindowsContextMenuEntry): string {
  const labels = entry.locations.map(
    (location) =>
      CONTEXT_MENU_LOCATIONS[location as keyof typeof CONTEXT_MENU_LOCATIONS] || location
  )
  return labels.length > 3
    ? `${labels.slice(0, 3).join('、')} 等 ${labels.length} 处`
    : labels.join('、')
}

/**
 * 生成来源说明，区分注册范围与按 CLSID 屏蔽的扩展。
 * @param entry 菜单项
 * @returns 来源文本
 */
function scopeText(entry: WindowsContextMenuEntry): string {
  if (entry.kind === 'verb') return entry.hive === 'HKCU' ? '当前用户' : '所有用户'
  if (entry.blockedBy?.includes('HKLM')) return '已由系统级策略屏蔽'
  return '按扩展屏蔽'
}

/**
 * 将记录中的 ISO 时间转换为本地可读时间。
 * @param value ISO 时间字符串
 * @returns 本地时间文本；无法解析时返回原值
 */
function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

/**
 * 切换单个菜单项的选择状态。
 * @param entry 菜单项
 * @returns 无返回值
 */
function toggleSelect(entry: WindowsContextMenuEntry): void {
  const next = new Set(selected.value)
  if (next.has(entry.id)) next.delete(entry.id)
  else next.add(entry.id)
  selected.value = next
}

/**
 * 批量加入或移除选择。
 * @param items 菜单项
 * @param checked 是否选中
 * @returns 无返回值
 */
function setSelection(items: WindowsContextMenuEntry[], checked: boolean): void {
  const next = new Set(selected.value)
  for (const item of items) {
    if (checked) next.add(item.id)
    else next.delete(item.id)
  }
  selected.value = next
}

/**
 * 全选当前筛选结果；系统组件需显式筛选或逐项勾选。
 * @returns 无返回值
 */
function toggleSelectAll(): void {
  setSelection(bulkCandidates.value, !allSelected.value)
}

/**
 * 判断分组内可选项是否已全部选中。
 * @param group 菜单分组
 * @returns 是否全选
 */
function groupSelected(group: EntryGroup): boolean {
  const items = group.items.filter(isSelectable)
  return items.length > 0 && items.every((item) => selected.value.has(item.id))
}

/**
 * 刷新真实注册表状态和修改记录，失败时展示错误并允许重试。
 * @returns 刷新完成后结束的 Promise
 */
async function refresh(): Promise<void> {
  if (busy.value) return
  supported.value = window.ztools.internal.getPlatform() === 'win32'
  if (!supported.value) return
  busy.value = true
  loadError.value = ''
  historyError.value = ''
  try {
    const [result, history] = await Promise.all([
      window.ztools.internal.listWindowsContextMenus(),
      window.ztools.internal.getWindowsContextMenuBackups()
    ])
    if (history.success) {
      backups.value = history.backups || []
      historyError.value = history.warnings?.join('\n') || ''
    } else historyError.value = history.error || '读取修改记录失败'
    if (!result.success) throw new Error(result.error || '读取菜单失败')
    entries.value = result.entries || []
    environment.value = result.environment || null
    listWarnings.value = result.warnings || []
    // 仅保留仍存在且可操作的选择，避免对已消失的菜单项发起修改。
    const available = new Set(entries.value.filter(isSelectable).map((entry) => entry.id))
    selected.value = new Set([...selected.value].filter((id) => available.has(id)))
  } catch (cause) {
    // 保留旧列表便于查看，但错误状态下禁止基于旧数据执行修改。
    loadError.value = String(cause)
  } finally {
    loaded.value = true
    busy.value = false
  }
}

/**
 * 根据逐项结果汇总反馈，并清除已成功项的选择。
 * @param result 后端返回的批量结果
 * @param names 菜单项标识到名称的映射
 * @param verb 操作名称
 * @returns 无返回值
 * @throws 后端未返回逐项结果且整体失败时抛错
 */
function report(result: ContextMenuResult, names: Map<string, string>, verb: string): void {
  const results = result.results || []
  if (!results.length) {
    if (!result.success) throw new Error(result.error || `${verb}失败`)
    return
  }
  const failed = results.filter((item) => !item.success)
  if (results.some((item) => item.success && item.changed !== false)) needsRestart.value = true
  setSelection(
    results
      .filter((item) => item.success)
      .map((item) => entries.value.find((entry) => entry.id === item.id))
      .filter((entry): entry is WindowsContextMenuEntry => !!entry),
    false
  )
  if (failed.length) {
    error(
      `${verb}完成 ${results.length - failed.length} 项，失败 ${failed.length} 项：\n` +
        failed.map((item) => `${names.get(item.id) || item.id}：${item.error}`).join('\n')
    )
  } else success(`已${verb} ${results.length} 项。可在「修改记录」中撤销。`)
}

/**
 * 确认影响范围后批量设置状态，并重新读取注册表避免乐观状态误报。
 * @param targets 要修改的菜单项
 * @param target 目标状态
 * @returns 修改和刷新完成后结束的 Promise
 */
async function applyStates(
  targets: WindowsContextMenuEntry[],
  target: ContextMenuState
): Promise<void> {
  if (writeLocked.value) return
  const eligible = targets.filter((entry) => supportsState(entry.kind, target) && !adminOnly(entry))
  const changes = eligible.filter((entry) => entry.state !== target)
  const skipped = targets.length - eligible.length
  if (!changes.length) {
    success(
      skipped
        ? `所选项不支持「${ACTION_TEXT[target]}」、需要管理员权限或已处于该状态。`
        : '所选项已处于该状态，无需修改。'
    )
    return
  }
  busy.value = true
  try {
    const lines = [
      changes.length === 1
        ? `${changes[0].name}\n${changes[0].id}`
        : `共 ${changes.length} 项：${changes
            .slice(0, 5)
            .map((entry) => entry.name)
            .join('、')}${changes.length > 5 ? ' 等' : ''}`
    ]
    if (skipped) lines.push(`另有 ${skipped} 项不支持该操作或需要管理员权限，已跳过。`)
    lines.push('修改前逐项备份并保存修改记录，可随时撤销。')
    if (changes.some((entry) => entry.kind === 'verb' && entry.hive === 'HKLM')) {
      lines.push('包含所有用户（HKLM）项，需要以管理员身份运行 CAI.Tools。')
    }
    if (changes.some((entry) => entry.kind !== 'verb')) {
      lines.push('Shell 扩展与新式菜单按 CLSID 屏蔽（写入当前用户），同一扩展在所有位置同时生效。')
    }
    const system = changes.filter((entry) => entry.system).length
    if (system && target !== 'shown') {
      lines.push(`包含 ${system} 个 Windows 系统组件，禁用可能影响系统功能。`)
    }
    if (changes.some((entry) => entry.kind === 'packaged') && environment.value?.classicMenu) {
      lines.push('当前已启用经典菜单，新式菜单项的变化需切回新式菜单后才能看到。')
    }
    const accepted = await confirm({
      title: `${ACTION_TEXT[target]}右键菜单项`,
      message: lines.join('\n'),
      confirmText: `备份并${ACTION_TEXT[target]}`
    })
    if (!accepted) return
    const result = await window.ztools.internal.applyWindowsContextMenuStates(
      changes.map((entry) => ({ id: entry.id, state: target, label: entry.name }))
    )
    report(result, new Map(changes.map((entry) => [entry.id, entry.name])), ACTION_TEXT[target])
  } catch (cause) {
    error(String(cause))
  } finally {
    // 无论写入成功与否都刷新，恢复列表与系统的实际状态一致。
    busy.value = false
    await refresh()
  }
}

/**
 * 根据持久化记录撤销修改，操作后重新读取菜单和记录。
 * @param items 要还原的记录
 * @returns 还原及刷新完成后结束的 Promise
 */
async function restore(items: ContextMenuBackup[]): Promise<void> {
  if (busy.value || historyError.value || !items.length) return
  busy.value = true
  try {
    const single = items.length === 1 ? items[0] : null
    const accepted = await confirm({
      title: single ? '撤销此修改' : '还原全部可撤销的修改',
      message: single
        ? `${single.label}\n${single.entryId}\n恢复为「${RECORD_STATE_TEXT[single.fromState] || single.fromState}」。仅撤销本工具写入的值，被外部修改时停止还原。所有用户项仍需管理员权限。`
        : `共 ${items.length} 条记录，将逐条恢复为修改前的状态。\n仅撤销本工具写入的值，被外部修改的记录会跳过并提示。`,
      confirmText: '确认还原'
    })
    if (!accepted) return
    const result = await window.ztools.internal.restoreWindowsContextMenus(
      items.map((item) => item.backupId)
    )
    const results = result.results || []
    const failed = results.filter((item) => !item.success)
    if (!results.length && !result.success) throw new Error(result.error || '还原失败')
    if (results.length - failed.length > 0) needsRestart.value = true
    if (failed.length) {
      const labels = new Map(items.map((item) => [item.backupId, item.label]))
      throw new Error(
        `还原完成 ${results.length - failed.length} 条，失败 ${failed.length} 条：\n` +
          failed.map((item) => `${labels.get(item.id) || item.id}：${item.error}`).join('\n')
      )
    }
    success(`已还原 ${results.length} 条修改，并通过回读校验。`)
  } catch (cause) {
    error(String(cause))
  } finally {
    busy.value = false
    await refresh()
  }
}

/**
 * 切换 Windows 11 经典右键菜单。
 * @returns 修改及刷新完成后结束的 Promise
 */
async function toggleClassic(): Promise<void> {
  const env = environment.value
  if (!env || writeLocked.value) return
  const next = !env.classicMenu
  busy.value = true
  try {
    const accepted = await confirm({
      title: next ? '启用经典右键菜单' : '恢复 Windows 11 新式右键菜单',
      message: next
        ? '在当前用户下写入经典菜单开关：右键直接显示完整的传统菜单，新式菜单项不再出现。\n修改前保存修改记录；重启资源管理器后生效。'
        : '删除当前用户的经典菜单开关，恢复 Windows 11 新式菜单。\n修改前保存修改记录；重启资源管理器后生效。',
      confirmText: next ? '备份并启用' : '备份并恢复'
    })
    if (!accepted) return
    const result = await window.ztools.internal.setWindowsClassicContextMenu(next)
    if (!result.success) throw new Error(result.error || '修改失败')
    needsRestart.value = true
    success(next ? '已启用经典右键菜单。' : '已恢复新式右键菜单。')
  } catch (cause) {
    error(String(cause))
  } finally {
    busy.value = false
    await refresh()
  }
}

/**
 * 确认后重启资源管理器，使屏蔽列表与经典菜单修改生效。
 * @returns 重启完成后结束的 Promise
 */
async function restartExplorer(): Promise<void> {
  if (busy.value || !supported.value) return
  busy.value = true
  try {
    const accepted = await confirm({
      title: '重启资源管理器',
      message:
        '将结束并重新启动 explorer.exe：已打开的文件夹窗口会关闭，任务栏和桌面会短暂消失后恢复。\n正在进行的文件复制等操作可能被中断。',
      confirmText: '立即重启'
    })
    if (!accepted) return
    const result = await window.ztools.internal.restartWindowsExplorer()
    if (!result.success) throw new Error(result.error || '重启失败')
    needsRestart.value = false
    success('资源管理器已重启，请重新打开右键菜单查看效果。')
  } catch (cause) {
    error(String(cause))
  } finally {
    busy.value = false
  }
}

/**
 * 从工具顶部直接跳转到修改记录，避免菜单长列表遮挡还原入口。
 * @returns 无返回值
 */
function showRestoreHistory(): void {
  historySection.value?.scrollIntoView({ block: 'start' })
}

/**
 * 在确认框中使用 Escape 取消操作，防止误触发宿主退出。
 * @param event 当前按键事件
 * @returns 无返回值
 */
function handleEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape' && dialog.visible) {
    event.preventDefault()
    event.stopImmediatePropagation()
    finish(false)
  }
}

onMounted(refresh)
window.ztools.onPluginEnter(() => {
  window.ztools.setExpendHeight(620)
  void refresh()
})
window.addEventListener('focus', refresh)
window.addEventListener('keydown', handleEscape, true)
onBeforeUnmount(() => {
  window.removeEventListener('focus', refresh)
  window.removeEventListener('keydown', handleEscape, true)
  finish(false)
})
</script>

<template>
  <section class="context-menu-page">
    <header>
      <div>
        <h2>Windows 右键菜单管理</h2>
        <p>整理文件资源管理器的右键菜单、Shell 扩展和 Windows 11 新式菜单</p>
      </div>
      <div class="header-actions">
        <button
          :disabled="busy || !supported"
          aria-label="查看修改记录"
          @click="showRestoreHistory"
        >
          修改记录
        </button>
        <button :disabled="busy || !supported" @click="restartExplorer">重启资源管理器</button>
        <button :disabled="busy || !supported" @click="refresh">
          {{ busy ? '处理中…' : '刷新' }}
        </button>
      </div>
    </header>
    <p v-if="notice.message" class="feedback" :class="notice.type" role="status">
      {{ notice.message }}
    </p>
    <div v-if="!supported" class="notice">此工具仅支持 Windows，请在 Windows 电脑上使用。</div>
    <template v-else>
      <div v-if="needsRestart" class="restart-banner">
        <span>修改已写入。Shell 扩展屏蔽和经典菜单需要重启资源管理器后生效。</span>
        <button :disabled="busy" @click="restartExplorer">立即重启资源管理器</button>
      </div>
      <div class="notice">
        菜单命令可设为显示、仅按住 Shift 显示或禁用；Shell
        扩展和新式菜单通过当前用户的屏蔽列表禁用，不改动软件自身的注册项。所有修改前自动导出 .reg
        备份并保存修改记录，可在下方逐条或全部撤销。暂不包含特定文件类型（如 .txt）专属的菜单命令。
      </div>
      <div v-if="environment" class="environment">
        <div v-if="environment.win11" class="environment-row">
          <div>
            <strong>经典右键菜单</strong>
            <span class="badge">{{ environment.classicMenu ? '已开启' : '已关闭' }}</span>
            <p>开启后右键直接显示完整的传统菜单，Windows 11 新式菜单项不再出现。</p>
          </div>
          <button :disabled="writeLocked" @click="toggleClassic">
            {{ environment.classicMenu ? '恢复新式菜单' : '启用经典菜单' }}
          </button>
        </div>
        <p v-if="!environment.isAdmin" class="hint">
          当前未以管理员身份运行：所有用户（HKLM）的菜单命令和系统级屏蔽项为只读。
        </p>
      </div>
      <div class="filters">
        <input
          v-model="query"
          aria-label="搜索菜单"
          placeholder="搜索名称、程序、命令或注册表路径"
        />
        <select v-model="kind" aria-label="菜单类型">
          <option value="">全部类型</option>
          <option v-for="(label, key) in CONTEXT_MENU_KIND_LABELS" :key="key" :value="key">
            {{ label }}
          </option>
        </select>
        <select v-model="scope" aria-label="菜单位置">
          <option value="">全部位置</option>
          <option v-for="(label, key) in CONTEXT_MENU_LOCATIONS" :key="key" :value="key">
            {{ label }}
          </option>
        </select>
        <select v-model="state" aria-label="菜单状态">
          <option value="">全部状态</option>
          <option v-for="item in STATES" :key="item" :value="item">
            {{ STATUS_TEXT[item] }}
          </option>
        </select>
        <select v-model="source" aria-label="菜单来源">
          <option value="">全部来源</option>
          <option value="third">第三方程序</option>
          <option value="system">Windows 系统组件</option>
        </select>
        <label class="check">
          <input v-model="grouped" type="checkbox" aria-label="按程序分组" />按程序分组
        </label>
      </div>
      <p v-if="loadError" class="error" role="alert">{{ loadError }}。请检查读取权限后点击刷新。</p>
      <p v-for="warning in listWarnings" :key="warning" class="hint">{{ warning }}</p>
      <div class="toolbar">
        <label class="check">
          <input
            type="checkbox"
            aria-label="全选当前结果"
            :checked="allSelected"
            :disabled="writeLocked || !bulkCandidates.length"
            @change="toggleSelectAll"
          />全选当前结果<span class="muted">（不含系统组件）</span>
        </label>
        <span class="count">共 {{ entries.length }} 项，当前显示 {{ filtered.length }} 项</span>
      </div>
      <div v-if="selected.size" class="batch-bar" role="toolbar" aria-label="批量操作">
        <strong>已选 {{ selected.size }} 项</strong>
        <button :disabled="writeLocked" @click="applyStates(selectedEntries, 'disabled')">
          批量禁用
        </button>
        <button :disabled="writeLocked" @click="applyStates(selectedEntries, 'extended')">
          仅 Shift 显示
        </button>
        <button :disabled="writeLocked" @click="applyStates(selectedEntries, 'shown')">
          批量显示
        </button>
        <button :disabled="busy" @click="selected = new Set()">清空选择</button>
      </div>
      <p v-if="busy && !loaded" class="empty">正在读取右键菜单（含新式菜单，约需数秒）…</p>
      <p v-else-if="!busy && !loadError && !filtered.length" class="empty">未找到匹配的菜单项。</p>
      <section v-for="group in groups" :key="group.name" class="group">
        <h3 v-if="grouped" class="group-title">
          <label class="check">
            <input
              type="checkbox"
              :aria-label="`选择 ${group.name} 的全部菜单项`"
              :checked="groupSelected(group)"
              :disabled="writeLocked || !group.items.some(isSelectable)"
              @change="setSelection(group.items.filter(isSelectable), !groupSelected(group))"
            />{{ group.name }}
          </label>
          <span class="muted">
            {{ group.items.length }} 项{{ group.changed ? `，${group.changed} 项已隐藏` : '' }}
          </span>
        </h3>
        <article v-for="entry in group.items" :key="entry.id" class="entry">
          <input
            type="checkbox"
            class="entry-check"
            :aria-label="`选择 ${entry.name}`"
            :checked="selected.has(entry.id)"
            :disabled="writeLocked || !isSelectable(entry)"
            :title="isSelectable(entry) ? '' : '需要以管理员身份运行 CAI.Tools'"
            @change="toggleSelect(entry)"
          />
          <div class="entry-info">
            <strong>{{ entry.name }}</strong>
            <span class="badge">{{ CONTEXT_MENU_KIND_LABELS[entry.kind] }}</span>
            <span class="badge">{{ locationText(entry) }}</span>
            <span class="badge">{{ scopeText(entry) }}</span>
            <span v-if="entry.system" class="badge warn">系统组件</span>
            <span v-if="adminOnly(entry)" class="badge warn">需管理员</span>
            <p>{{ entry.command || '无直接命令（可能为子菜单或委托执行项）' }}</p>
            <code>{{ entry.id }}</code>
          </div>
          <div class="state-switch" role="group" :aria-label="`${entry.name} 的状态`">
            <button
              v-for="item in STATES.filter((value) => supportsState(entry.kind, value))"
              :key="item"
              :class="{ active: entry.state === item }"
              :aria-pressed="entry.state === item"
              :disabled="writeLocked || adminOnly(entry) || entry.state === item"
              :aria-label="`${ACTION_TEXT[item]} ${entry.name}`"
              @click="applyStates([entry], item)"
            >
              {{ CONTEXT_MENU_STATE_LABELS[item] }}
            </button>
          </div>
          <span class="status">{{ STATUS_TEXT[entry.state] }}</span>
        </article>
      </section>
      <section ref="historySection" class="restore-history">
        <div class="history-title">
          <h3>修改记录</h3>
          <button
            :disabled="busy || !!historyError || !restorable.length"
            @click="restore(restorable)"
          >
            还原全部（{{ restorable.length }}）
          </button>
        </div>
        <p>
          撤销只恢复本工具写入的值，不覆盖命令或重新创建已删除的菜单项；值被外部修改时停止还原。同一菜单项只能撤销最近一次修改。
        </p>
        <p v-if="historyError" class="error" role="alert">{{ historyError }}</p>
        <p v-if="!backups.length && !historyError">暂无修改记录。旧版 .reg 备份仍可手动导入。</p>
        <article v-for="backup in backups" :key="backup.backupId" class="entry">
          <div class="entry-info">
            <strong>{{ backup.label }}</strong>
            <span class="badge">
              {{ RECORD_STATE_TEXT[backup.fromState] || backup.fromState }} →
              {{ RECORD_STATE_TEXT[backup.toState] || backup.toState }}
            </span>
            <p>
              {{ formatTime(backup.createdAt) }} ·
              {{
                backup.restoredAt
                  ? `已于 ${formatTime(backup.restoredAt)} 还原`
                  : backup.canRestore
                    ? '可还原'
                    : '已有更新记录'
              }}
            </p>
            <code>{{ backup.entryId }}</code>
            <p>{{ backup.backupPath }}</p>
          </div>
          <button
            :disabled="busy || !!historyError || !backup.canRestore"
            :aria-label="`还原 ${backup.label}`"
            @click="restore([backup])"
          >
            还原
          </button>
        </article>
      </section>
    </template>
  </section>
  <div v-if="dialog.visible" class="modal-overlay">
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <h3 id="confirm-title">{{ dialog.title }}</h3>
      <p>{{ dialog.message }}</p>
      <footer>
        <button @click="finish(false)">取消</button
        ><button @click="finish(true)">{{ dialog.confirmText }}</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.context-menu-page {
  height: 100%;
  box-sizing: border-box;
  overflow-y: auto;
  padding: 24px;
  background: var(--bg-color);
  color: var(--text-color);
}
header,
.header-actions,
.filters,
.toolbar,
.batch-bar,
.entry,
.environment-row,
.history-title,
.restart-banner {
  display: flex;
  align-items: center;
  gap: 12px;
}
header {
  justify-content: space-between;
  margin-bottom: 20px;
}
h2 {
  margin: 0 0 8px;
  font-size: 20px;
}
p {
  color: var(--text-secondary);
  font-size: 13px;
}
header p {
  margin: 0;
}
.notice,
.environment {
  padding: 10px 14px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.6;
}
.environment {
  margin-top: 12px;
}
.environment-row {
  justify-content: space-between;
}
.environment p,
.hint {
  margin: 2px 0 0;
  font-size: 12px;
}
.restart-banner {
  justify-content: space-between;
  margin-bottom: 12px;
  padding: 10px 14px;
  border: 1px solid var(--accent-color);
  border-radius: 8px;
  font-size: 13px;
}
.filters {
  margin-top: 20px;
  flex-wrap: wrap;
}
input,
select,
button {
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-color);
  color: var(--text-color);
}
.filters > input {
  flex: 1;
  min-width: 170px;
}
input[type='checkbox'] {
  padding: 0;
  margin: 0;
  width: 16px;
  height: 16px;
  accent-color: var(--accent-color);
}
.check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
}
button {
  cursor: pointer;
  white-space: nowrap;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.toolbar {
  justify-content: space-between;
  margin-top: 16px;
}
.batch-bar {
  position: sticky;
  top: -24px;
  z-index: 1;
  flex-wrap: wrap;
  margin-top: 12px;
  padding: 10px 14px;
  border: 1px solid var(--accent-color);
  border-radius: 8px;
  background: var(--bg-color);
}
.group-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 20px 0 0;
  padding-bottom: 8px;
  border-bottom: 2px solid var(--border-color);
  font-size: 15px;
}
.entry {
  padding: 16px 0;
  border-bottom: 1px solid var(--border-color);
}
.entry-info {
  min-width: 0;
  flex: 1;
}
.entry-check {
  align-self: flex-start;
  margin-top: 4px;
}
.entry p,
code,
.backup {
  overflow-wrap: anywhere;
  user-select: text;
}
code {
  font-size: 11px;
  color: var(--text-secondary);
}
.badge {
  display: inline-block;
  margin: 4px 0 0 8px;
  color: var(--text-secondary);
  font-size: 11px;
}
.badge.warn {
  color: var(--danger-color);
}
.muted,
.count {
  color: var(--text-secondary);
  font-size: 12px;
}
.state-switch {
  display: inline-flex;
}
.state-switch button {
  padding: 6px 10px;
  border-radius: 0;
  font-size: 12px;
}
.state-switch button + button {
  border-left: none;
}
.state-switch button:first-child {
  border-radius: 6px 0 0 6px;
}
.state-switch button:last-child {
  border-radius: 0 6px 6px 0;
}
.state-switch button.active {
  background: var(--accent-color);
  border-color: var(--accent-color);
  color: #fff;
  opacity: 1;
}
.status {
  min-width: 48px;
  font-size: 12px;
  color: var(--text-secondary);
}
.restore-history {
  margin-top: 28px;
}
.history-title {
  justify-content: space-between;
}
.error {
  color: var(--danger-color);
}
.empty {
  padding: 36px 0;
  text-align: center;
}
</style>
