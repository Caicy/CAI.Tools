import type { ContextMenuChange, ContextMenuResult } from '@shared/windowsContextMenu'

declare global {
  interface Window {
    ztools: {
      onPluginEnter: (callback: () => void) => void
      setExpendHeight: (height: number) => void
      internal: {
        getPlatform: () => string
        listWindowsContextMenus: () => Promise<ContextMenuResult>
        applyWindowsContextMenuStates: (changes: ContextMenuChange[]) => Promise<ContextMenuResult>
        getWindowsContextMenuBackups: () => Promise<ContextMenuResult>
        restoreWindowsContextMenus: (backupIds: string[]) => Promise<ContextMenuResult>
        setWindowsClassicContextMenu: (enabled: boolean) => Promise<ContextMenuResult>
        restartWindowsExplorer: () => Promise<ContextMenuResult>
      }
    }
  }
}
