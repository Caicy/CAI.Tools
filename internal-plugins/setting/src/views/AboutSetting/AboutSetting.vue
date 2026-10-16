<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useToast } from '@/components'
import { GITHUB_REPOSITORY_URL } from '@shared/updateSource'
import type { LocalEditionInfo } from '@shared/localEdition'

const { error } = useToast()
const appVersion = ref('')
const localEdition = ref<LocalEditionInfo | null>(null)
const isCheckingUpdate = ref(false)
const autoCheckUpdate = ref(true)
const updateMessage = ref('仅接收 Caicy/CAI.Tools 的 local 预发布版本。')
const currentYear = new Date().getFullYear()

/**
 * 读取本机构建版本和能力信息，挂载时只访问本地状态。
 * @returns 本机信息读取完成后结束的 Promise。
 */
async function loadLocalEdition(): Promise<void> {
  try {
    // 此处只读取本机信息，不触发网络检查。
    const [version, info] = await Promise.all([
      window.ztools.internal.getAppVersion(),
      window.ztools.internal.getLocalEditionInfo()
    ])
    appVersion.value = version
    localEdition.value = info
    const settings = await window.ztools.internal.dbGet('settings-general')
    autoCheckUpdate.value = settings?.autoCheckUpdate !== false
  } catch (cause) {
    console.error('读取本地版本信息失败:', cause)
    appVersion.value = '未知'
    error('读取本地版本信息失败')
  }
}

/**
 * 检查自有版本并由宿主显示下载与安装窗口。
 * @returns 检查结束后的 Promise。
 */
async function handleCheckUpdate(): Promise<void> {
  if (isCheckingUpdate.value) return
  isCheckingUpdate.value = true
  updateMessage.value = '正在检查 CAI.Tools 更新…'
  try {
    // 使用内部权限入口，版本来源与安装目标由主进程决定。
    const result = await window.ztools.internal.updaterCheckUpdate()
    if (result.error) updateMessage.value = '检查失败：' + result.error
    else if (result.migrationRequired)
      updateMessage.value = '当前安装不具备自动更新条件，请先安装一次启用更新的完整版本。'
    else
      updateMessage.value = result.hasUpdate
        ? '发现 CAI.Tools v' + result.latestVersion + '，请在更新窗口中下载并安装。'
        : '当前已是最新的 CAI.Tools local 版本。'
  } catch (cause) {
    updateMessage.value = '检查更新失败，请检查网络后重试。'
    console.error('检查 CAI.Tools 更新失败:', cause)
  } finally {
    isCheckingUpdate.value = false
  }
}

/**
 * 保存自动检查偏好并同步宿主定时器。
 * @returns 设置保存后的 Promise。
 */
async function changeAutoCheck(): Promise<void> {
  try {
    // 合并现有文档，避免覆盖主题、快捷键等其他偏好。
    const old = await window.ztools.internal.dbGet('settings-general')
    const saved = await window.ztools.internal.dbPut('settings-general', {
      ...(old || {}),
      autoCheckUpdate: autoCheckUpdate.value
    })
    if (!saved.ok) throw new Error(saved.error || '设置写入失败')
    const applied = await window.ztools.internal.updaterSetAutoCheck(autoCheckUpdate.value)
    if (!applied.success) throw new Error(applied.error || '开关应用失败')
  } catch (cause) {
    error('保存自动检查设置失败')
    console.error(cause)
  }
}

/**
 * 打开上游项目的交流群页面。
 * @returns 无返回值。
 */
function openQQGroup(): void {
  window.ztools.shellOpenExternal('https://qm.qq.com/q/fXCzbh3Txe')
}

/**
 * 打开 CAI.Tools 自有源代码仓库。
 * @returns 无返回值。
 */
function openGithub(): void {
  window.ztools.shellOpenExternal(GITHUB_REPOSITORY_URL)
}

/**
 * 打开上游作者的赞助页面。
 * @returns 无返回值。
 */
function openSponsor(): void {
  window.ztools.shellOpenExternal('https://afdian.com/a/ZTools')
}

onMounted(loadLocalEdition)
</script>
<template>
  <div class="content-panel">
    <div class="about-container">
      <!-- Logo -->
      <div class="about-logo">
        <img src="/logo.png" alt="CAI.Tools" draggable="false" />
      </div>

      <!-- 应用名称 -->
      <h1 class="about-title">CAI.Tools</h1>

      <!-- 版本号 -->
      <div class="about-version">
        本地版本 v{{ appVersion || '读取中' }} · 上游基线 ZTools v{{
          localEdition?.upstreamBase || '读取中'
        }}
      </div>
      <p class="local-edition-description">本地工作台 · 自配 AI 供应商 · 本机数据</p>

      <!-- 信息卡片 -->
      <div class="about-cards">
        <div class="about-card">
          <div class="card-icon card-icon-author">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path
                d="M20 21V19C20 17.9391 19.5786 16.9217 18.8284 16.1716C18.0783 15.4214 17.0609 15 16 15H8C6.93913 15 5.92172 15.4214 5.17157 16.1716C4.42143 16.9217 4 17.9391 4 19V21"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <circle
                cx="12"
                cy="7"
                r="4"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
          <div class="card-label">上游作者</div>
          <div class="card-value">Zing</div>
        </div>

        <div class="about-card clickable" @click="openQQGroup">
          <div class="card-icon card-icon-qq">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path
                d="M21 11.5C21.0034 12.8199 20.6951 14.1219 20.1 15.3C19.3944 16.7118 18.3098 17.8992 16.9674 18.7293C15.6251 19.5594 14.0782 19.9994 12.5 20C11.1801 20.0034 9.87812 19.6951 8.7 19.1L3 21L4.9 15.3C4.30493 14.1219 3.99656 12.8199 4 11.5C4.00061 9.92179 4.44061 8.37488 5.27072 7.03258C6.10083 5.69028 7.28825 4.6056 8.7 3.90003C9.87812 3.30496 11.1801 2.99659 12.5 3.00003H13C15.0843 3.11502 17.053 3.99479 18.5291 5.47089C20.0052 6.94699 20.885 8.91568 21 11V11.5Z"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
          <div class="card-label">上游交流群</div>
          <div class="card-value">
            1076942619
            <svg class="external-icon" width="12" height="12" viewBox="0 0 24 24" fill="none">
              <path
                d="M18 13V19C18 19.5304 17.7893 20.0391 17.4142 20.4142C17.0391 20.7893 16.5304 21 16 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V8C3 7.46957 3.21071 6.96086 3.58579 6.58579C3.96086 6.21071 4.46957 6 5 6H11"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path
                d="M15 3H21V9"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path
                d="M10 14L21 3"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
        </div>

        <div class="about-card clickable" @click="openGithub">
          <div class="card-icon card-icon-github">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path
                d="M9 19C4 20.5 4 16.5 2 16M16 22V18.13C16.0375 17.6532 15.9731 17.1738 15.811 16.7238C15.6489 16.2738 15.3929 15.8634 15.06 15.52C18.2 15.17 21.5 13.98 21.5 8.52C21.4997 7.12383 20.9627 5.7812 20 4.77C20.4559 3.54851 20.4236 2.19835 19.91 1C19.91 1 18.73 0.650001 16 2.48C13.708 1.85882 11.292 1.85882 9 2.48C6.27 0.650001 5.09 1 5.09 1C4.57638 2.19835 4.54414 3.54851 5 4.77C4.03013 5.7887 3.49252 7.14346 3.5 8.55C3.5 13.97 6.8 15.16 9.94 15.55C9.611 15.89 9.35726 16.2954 9.19531 16.7399C9.03335 17.1844 8.96681 17.658 9 18.13V22"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
          <div class="card-label">CAI.Tools 源码</div>
          <div class="card-value">
            查看代码
            <svg class="external-icon" width="12" height="12" viewBox="0 0 24 24" fill="none">
              <path
                d="M18 13V19C18 19.5304 17.7893 20.0391 17.4142 20.4142C17.0391 20.7893 16.5304 21 16 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V8C3 7.46957 3.21071 6.96086 3.58579 6.58579C3.96086 6.21071 4.46957 6 5 6H11"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path
                d="M15 3H21V9"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path
                d="M10 14L21 3"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
        </div>

        <div class="about-card clickable" @click="openSponsor">
          <div class="card-icon card-icon-sponsor">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path
                d="M20.84 4.61C20.3292 4.099 19.7228 3.69364 19.0554 3.41708C18.3879 3.14052 17.6725 2.99817 16.95 2.99817C16.2275 2.99817 15.5121 3.14052 14.8446 3.41708C14.1772 3.69364 13.5708 4.099 13.06 4.61L12 5.67L10.94 4.61C9.9083 3.57831 8.50903 2.99871 7.05 2.99871C5.59096 2.99871 4.19169 3.57831 3.16 4.61C2.1283 5.6417 1.54871 7.04097 1.54871 8.5C1.54871 9.95903 2.1283 11.3583 3.16 12.39L4.22 13.45L12 21.23L19.78 13.45L20.84 12.39C21.351 11.8792 21.7563 11.2728 22.0329 10.6054C22.3095 9.93789 22.4518 9.22249 22.4518 8.5C22.4518 7.77751 22.3095 7.0621 22.0329 6.39464C21.7563 5.72718 21.351 5.12075 20.84 4.61Z"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
          <div class="card-label">赞助上游</div>
          <div class="card-value">支持作者</div>
        </div>
      </div>

      <!-- 核心技术 -->
      <div class="about-techs">
        <span class="tech-tag">Electron 41</span>
        <span class="tech-tag">Vue 3</span>
        <span class="tech-tag">TypeScript</span>
        <span class="tech-tag">LMDB</span>
        <span class="tech-tag">Fuse.js</span>
      </div>

      <!-- 检查更新按钮 -->
      <button class="check-update-btn" :disabled="isCheckingUpdate" @click="handleCheckUpdate">
        <svg v-if="!isCheckingUpdate" width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path
            d="M23 4V10H17"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M20.49 15C19.84 16.8399 18.6096 18.4187 16.9842 19.4985C15.3588 20.5783 13.4315 21.1006 11.4952 20.9866C9.55886 20.8726 7.70756 20.1286 6.22015 18.8667C4.73274 17.6047 3.6894 15.8932 3.24965 13.9901C2.8099 12.087 2.99716 10.0952 3.78477 8.30479C4.57238 6.51435 5.91702 5.02117 7.61403 4.04909C9.31105 3.07702 11.27 2.67856 13.2091 2.91282C15.1481 3.14708 16.9632 4.0015 18.36 5.35L23 10"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <svg v-else class="spinning" width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M12 2V6" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          <path
            d="M12 18V22"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            opacity="0.3"
          />
          <path
            d="M4.93 4.93L7.76 7.76"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
          <path
            d="M16.24 16.24L19.07 19.07"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            opacity="0.3"
          />
          <path
            d="M2 12H6"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            opacity="0.5"
          />
          <path
            d="M18 12H22"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            opacity="0.5"
          />
          <path
            d="M4.93 19.07L7.76 16.24"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            opacity="0.3"
          />
          <path
            d="M16.24 7.76L19.07 4.93"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
        {{ isCheckingUpdate ? '检查中...' : '检查 CAI.Tools 更新' }}
      </button>

      <div class="upstream-notice" role="status" aria-live="polite">
        <p>{{ updateMessage }}</p>
        <p class="upstream-notice-hint">
          首次使用需安装完整安装版；ZIP 版请先安装。更新保留本机设置、插件和数据库。
        </p>
        <label
          ><input v-model="autoCheckUpdate" type="checkbox" @change="changeAutoCheck" /> 自动检查
          CAI.Tools 更新（下载和安装前需确认）</label
        >
      </div>

      <!-- 保留上游版权归属 -->
      <div class="about-copyright">
        Copyright &copy; 2025-{{ currentYear }} ZTools. All rights reserved.
      </div>
    </div>
  </div>
</template>

<style scoped>
.content-panel {
  position: relative;
  height: 100%;
  overflow-y: auto;
}

.about-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40px 32px 32px;
  box-sizing: border-box;
}

.about-logo {
  width: 96px;
  height: 96px;
  margin-bottom: 16px;
}

.about-logo img {
  width: 100%;
  height: 100%;
  border-radius: 22px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.12);
}

.about-title {
  font-size: 28px;
  font-weight: 700;
  color: var(--text-color);
  margin: 0 0 6px;
}

.about-version {
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.local-edition-description {
  margin: 0 0 24px;
  color: var(--text-secondary);
  font-size: 13px;
}

.upstream-notice {
  width: 100%;
  max-width: 560px;
  box-sizing: border-box;
  padding: 14px 18px;
  margin-bottom: 20px;
  border: 1px solid var(--control-border);
  border-radius: 12px;
  background: var(--card-bg);
  color: var(--text-color);
  font-size: 13px;
  line-height: 1.6;
  text-align: center;
}

.upstream-notice p {
  margin: 0 0 8px;
}
.upstream-notice-hint {
  color: var(--text-secondary);
}

/* 卡片区域 */
.about-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  width: 100%;
  max-width: 560px;
  margin-bottom: 24px;
}

.about-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 18px 12px 16px;
  border-radius: 12px;
  border: 1px solid var(--control-border);
  background: var(--card-bg);
  transition: all 0.2s;
}

.about-card.clickable {
  cursor: pointer;
}

.about-card.clickable:hover {
  border-color: var(--primary-color);
  background: var(--active-bg);
}

.card-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 10px;
}

.card-icon-author {
  background: #e0f2fe;
  color: #0284c7;
}

.card-icon-qq {
  background: #dcfce7;
  color: #16a34a;
}

.card-icon-github {
  background: #f3f4f6;
  color: #374151;
}

.card-icon-sponsor {
  background: #fce7f3;
  color: #ec4899;
}

.card-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.card-value {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-color);
  display: flex;
  align-items: center;
  gap: 4px;
}

.external-icon {
  color: var(--text-secondary);
}

/* 核心技术标签 */
.about-techs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  margin-bottom: 28px;
}

.tech-tag {
  padding: 5px 14px;
  border-radius: 16px;
  font-size: 13px;
  color: var(--text-secondary);
  border: 1px solid var(--control-border);
  background: var(--card-bg);
}

/* 检查更新按钮 */
.check-update-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 32px;
  border-radius: 10px;
  border: none;
  background: #10b981;
  color: var(--text-on-primary);
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  margin-bottom: 24px;
}

.check-update-btn:hover:not(:disabled) {
  opacity: 0.9;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
}

.check-update-btn:active:not(:disabled) {
  transform: translateY(0);
}

.check-update-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.spinning {
  animation: spin 1s linear infinite;
}

/* 版权信息 */
.about-copyright {
  font-size: 12px;
  color: var(--text-secondary);
  opacity: 0.6;
}

/* 暗色模式适配 */
@media (prefers-color-scheme: dark) {
  .card-icon-author {
    background: rgba(2, 132, 199, 0.15);
  }

  .card-icon-qq {
    background: rgba(22, 163, 74, 0.15);
  }

  .card-icon-github {
    background: rgba(255, 255, 255, 0.1);
    color: #d1d5db;
  }

  .card-icon-sponsor {
    background: rgba(236, 72, 153, 0.15);
  }
}
</style>
