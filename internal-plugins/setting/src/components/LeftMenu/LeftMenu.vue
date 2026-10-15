<script setup lang="ts">
import type { MenuRouterItemType } from '@/router'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const router = useRouter()
const route = useRoute()
const menuRoutes = computed(
  () =>
    router
      .getRoutes()
      .filter((item) => item.path.split('/').length <= 2 && item.meta.menu) as MenuRouterItemType[]
)

/**
 * 切换右侧本机设置页面。
 * @param item 要切换到的菜单路由项。
 * @returns 无返回值。
 */
function setActiveMenu(item: MenuRouterItemType): void {
  // 菜单只提供已声明的本机功能路由。
  void router.replace({ name: item.name })
}
</script>

<template>
  <div class="settings-sidebar">
    <div class="menu-list">
      <div
        v-for="menuRoute in menuRoutes"
        :key="menuRoute.name"
        class="menu-item"
        :class="{ active: route.name === menuRoute.name }"
        @click="setActiveMenu(menuRoute)"
      >
        <div :class="menuRoute.meta?.menu?.icon ?? ''" class="menu-icon" style="font-size: 18px" />
        <span class="menu-label">{{ menuRoute.meta?.menu?.label ?? '' }}</span>
      </div>
    </div>
    <div class="local-workspace">
      <strong>CAI.Tools</strong>
      <span>本地工作台</span>
    </div>
  </div>
</template>

<style scoped>
/* 左侧菜单 */
.settings-sidebar {
  display: flex;
  flex-direction: column;
  width: 200px;
  height: 100%;
  border-right: 1px solid var(--divider-color);
  min-height: 0;
}

.menu-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: 10px;
  padding: 8px;
}

.menu-item {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  gap: 10px;
  margin-bottom: 6px;
  cursor: pointer;
  transition: all 0.2s;
  color: var(--text-color);
  border-radius: 8px;
}

.menu-item:last-child {
  margin-bottom: 0;
}

.menu-item:hover {
  background: var(--hover-bg);
}

.menu-item.active {
  background: var(--active-bg);
  color: var(--primary-color);
  font-weight: 500;
}

.local-workspace {
  display: grid;
  gap: 4px;
  margin: 0 8px 8px;
  padding: 12px;
  border-top: 1px solid var(--divider-color);
  color: var(--text-color);
  font-size: 13px;
}

.local-workspace span {
  color: var(--text-secondary);
  font-size: 12px;
}
</style>
