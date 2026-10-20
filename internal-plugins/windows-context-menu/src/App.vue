<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useDialogs } from './dialogs'
import {
  CONTEXT_MENU_LOCATIONS,
  type WindowsContextMenuEntry,
  type ContextMenuBackup
} from '@shared/windowsContextMenu'

const { confirm, success, error, finish, dialog, notice } = useDialogs()
const supported = ref(window.ztools.internal.getPlatform() === 'win32')
const entries = ref<WindowsContextMenuEntry[]>([])
const busy = ref(false)
const query = ref('')
const scope = ref('')
const state = ref('')
const loadError = ref('')
const backupPath = ref('')
const backups = ref<ContextMenuBackup[]>([])
const historyError = ref('')
const historySection = ref<HTMLElement | null>(null)
const filtered = computed(() =>
  entries.value.filter(
    (entry) =>
      (!scope.value || entry.location === scope.value) &&
      (!state.value || String(entry.enabled) === state.value) &&
      `${entry.name} ${entry.command} ${entry.id}`.toLowerCase().includes(query.value.toLowerCase())
  )
)

/**
 * 刷新真实注册表状态，失败时展示错误并允许重试。
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
    } else historyError.value = history.error || '读取还原记录失败'
    if (!result.success) throw new Error(result.error || '读取菜单失败')
    entries.value = result.entries || []
  } catch (cause) {
    // 保留旧列表便于查看，但错误状态下禁止基于旧数据执行修改。
    loadError.value = String(cause)
  } finally {
    busy.value = false
  }
}

/**
 * 确认影响范围后请求备份及切换，并重新读取注册表避免乐观状态误报。
 * @param entry 当前菜单项
 * @returns 修改和刷新完成后结束的 Promise
 */
async function toggle(entry: WindowsContextMenuEntry): Promise<void> {
  if (busy.value || loadError.value || (entry.enabled && historyError.value)) return
  busy.value = true
  try {
    const accepted = await confirm({
      title: entry.enabled ? '禁用右键菜单项' : '启用右键菜单项',
      message: `${entry.name}\n${entry.id}\n修改前将自动备份该注册表项。${entry.hive === 'HKLM' ? '此项影响所有用户，需要以管理员身份运行 CAI.Tools。' : '此项仅影响当前用户。'}`,
      confirmText: entry.enabled ? '备份并禁用' : '备份并启用'
    })
    if (!accepted) return
    const result = await window.ztools.internal.setWindowsContextMenuEnabled(
      entry.id,
      !entry.enabled
    )
    if (!result.success) throw new Error(result.error || '修改失败')
    if (result.backupPath) backupPath.value = result.backupPath
    success('菜单项状态已更新，请重新打开资源管理器右键菜单查看。')
  } catch (cause) {
    error(String(cause))
  } finally {
    // 无论写入成功与否都刷新，恢复列表与系统的实际状态一致。
    busy.value = false
    await refresh()
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

/**
 * 从工具顶部直接跳转到持久化还原记录，避免菜单长列表遮挡还原入口。
 * @returns 无返回值
 */
function showRestoreHistory(): void {
  historySection.value?.scrollIntoView({ block: 'start' })
}

/**
 * 根据持久化记录还原禁用前的状态，操作后重新读取菜单和历史记录。
 * @param backup 对应的禁用备份记录
 * @returns 还原及刷新完成后结束的 Promise
 */
async function restore(backup: ContextMenuBackup): Promise<void> {
  if (busy.value || historyError.value) return
  busy.value = true
  try {
    if (
      !(await confirm({
        title: '还原禁用前状态',
        message: `${backup.entryId}\n仅撤销本工具的禁用标记，不覆盖菜单命令。所有用户项仍需管理员权限。`,
        confirmText: '确认还原'
      }))
    )
      return
    const result = await window.ztools.internal.restoreWindowsContextMenu(backup.backupId)
    if (!result.success) throw new Error(result.error || '还原失败')
    success('已还原禁用前状态，并通过回读校验。')
  } catch (cause) {
    error(String(cause))
  } finally {
    busy.value = false
    await refresh()
  }
}
</script>

<template>
  <section class="context-menu-page">
    <header>
      <div>
        <h2>Windows 右键菜单管理</h2>
        <p>整理文件资源管理器的传统右键菜单</p>
      </div>
      <div class="header-actions">
        <button
          :disabled="busy || !supported"
          aria-label="查看还原记录"
          @click="showRestoreHistory"
        >
          还原记录
        </button>
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
      <div class="notice">
        管理通用 shell 菜单项，通过 LegacyDisable 标记启用或禁用。Windows 11
        中通常显示在“显示更多选项”里。 暂不包含文件类型专属菜单、第三方 Shell
        扩展和新式菜单；“启用”仅表示未设置禁用标记，其他系统策略仍可能隐藏该项。 修改前自动导出 .reg
        备份，并保存还原记录。禁用后可在下方“禁用还原记录”中还原，重启应用后记录仍保留。当前用户同名项可能覆盖所有用户项。
      </div>
      <div class="filters">
        <input v-model="query" aria-label="搜索菜单" placeholder="搜索名称、命令或注册表路径" />
        <select v-model="scope" aria-label="菜单位置">
          <option value="">全部位置</option>
          <option v-for="(label, key) in CONTEXT_MENU_LOCATIONS" :key="key" :value="key">
            {{ label }}
          </option>
        </select>
        <select v-model="state" aria-label="菜单状态">
          <option value="">全部状态</option>
          <option value="true">已启用</option>
          <option value="false">已禁用</option>
        </select>
      </div>
      <p v-if="loadError" class="error" role="alert">{{ loadError }}。请检查读取权限后点击刷新。</p>
      <p v-if="backupPath" class="backup">最近备份：{{ backupPath }}</p>
      <p class="count">共 {{ entries.length }} 项，当前显示 {{ filtered.length }} 项</p>
      <p v-if="!busy && !loadError && !filtered.length" class="empty">未找到匹配的菜单项。</p>
      <article v-for="entry in filtered" :key="entry.id" class="entry">
        <div class="entry-info">
          <strong>{{ entry.name }}</strong>
          <span class="badge">{{ CONTEXT_MENU_LOCATIONS[entry.location] }}</span>
          <span class="badge">{{
            entry.hive === 'HKCU' ? '当前用户' : '所有用户 · 需管理员'
          }}</span>
          <p>{{ entry.command || '无直接命令（可能为子菜单或委托执行项）' }}</p>
          <code>{{ entry.id }}</code>
        </div>
        <button
          :disabled="busy || !!loadError || (entry.enabled && !!historyError)"
          :aria-label="`${entry.enabled ? '禁用' : '启用'} ${entry.name}`"
          @click="toggle(entry)"
        >
          {{ entry.enabled ? '禁用' : '启用' }}
        </button>
        <span class="status">{{ entry.enabled ? '已启用' : '已禁用' }}</span>
      </article>
      <section ref="historySection" class="restore-history">
        <h3>禁用还原记录</h3>
        <p>
          还原只撤销本工具的禁用标记，不覆盖命令或重新创建已删除的菜单项。标记被外部修改时会停止还原。
        </p>
        <p v-if="historyError" class="error" role="alert">{{ historyError }}</p>
        <p v-if="!backups.length && !historyError">暂无禁用记录。旧版 .reg 备份仍可手动导入。</p>
        <article v-for="backup in backups" :key="backup.backupId" class="entry">
          <div class="entry-info">
            <strong>{{ backup.entryId.split('\\').pop() }}</strong>
            <p>
              {{ backup.createdAt }} ·
              {{ backup.restoredAt ? '已还原' : backup.canRestore ? '可还原' : '已有更新记录' }}
            </p>
            <code>{{ backup.entryId }}</code>
            <p>{{ backup.backupPath }}</p>
          </div>
          <button
            :disabled="busy || !!historyError || !backup.canRestore"
            :aria-label="`还原 ${backup.entryId.split('\\').pop()}`"
            @click="restore(backup)"
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
.entry {
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
.notice {
  padding: 14px;
  background: var(--bg-color);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.8;
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
input {
  flex: 1;
  min-width: 170px;
}
button {
  cursor: pointer;
  white-space: nowrap;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.entry {
  padding: 16px 0;
  border-bottom: 1px solid var(--border-color);
}
.entry-info {
  min-width: 0;
  flex: 1;
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
.status {
  font-size: 12px;
  color: var(--text-secondary);
}
.error {
  color: var(--danger-color, #d14343);
}
.empty {
  padding: 36px 0;
  text-align: center;
}
</style>
