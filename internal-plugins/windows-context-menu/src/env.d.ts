import type { ContextMenuResult } from '@shared/windowsContextMenu'

declare global {
  interface Window {
    ztools: {
      onPluginEnter: (callback: () => void) => void
      setExpendHeight: (height: number) => void
      internal: {
        getPlatform: () => string
        listWindowsContextMenus: () => Promise<ContextMenuResult>
        setWindowsContextMenuEnabled: (id: string, enabled: boolean) => Promise<ContextMenuResult>
        getWindowsContextMenuBackups: () => Promise<ContextMenuResult>
        restoreWindowsContextMenu: (backupId: string) => Promise<ContextMenuResult>
      }
    }
  }
}
