<script setup lang="ts">
import { PluginDetail as SharedPluginDetail } from '@/components'
import type { PluginUninstallOptions, TabId } from '@/components'
import type { PluginDownloadState } from '../types'

defineProps<{
  plugin: any
  isLoading?: boolean
  downloadState?: PluginDownloadState
  isRunning?: boolean
  initialTab?: TabId
}>()

defineEmits<{
  (e: 'back'): void
  (e: 'open'): void
  (e: 'download'): void
  (e: 'upgrade'): void
  (e: 'uninstall', options: PluginUninstallOptions): void
  (e: 'kill'): void
  (e: 'open-folder'): void
  (e: 'package'): void
  (e: 'reload'): void
}>()
</script>

<template>
  <SharedPluginDetail
    :plugin="plugin"
    :is-loading="isLoading"
    :download-state="downloadState"
    :is-running="isRunning"
    :show-commands="false"
    :show-size="true"
    :show-download-count="true"
    :initial-tab="initialTab"
    @back="$emit('back')"
    @open="$emit('open')"
    @download="$emit('download')"
    @upgrade="$emit('upgrade')"
    @uninstall="$emit('uninstall', $event)"
    @kill="$emit('kill')"
    @open-folder="$emit('open-folder')"
    @package="$emit('package')"
    @reload="$emit('reload')"
  />
</template>
