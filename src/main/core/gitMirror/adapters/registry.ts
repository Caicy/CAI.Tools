import { codeSnippetsAdapter } from './codeSnippets'
import { aiHelperAdapter } from './aiHelper'
import type { Adapter, AdapterLookup } from './types'

/**
 * 根据插件 canonical 名与确切版本查找显式适配器。
 * @param name 插件名。
 * @param exactVersion 已安装的完整版本。
 * @returns 已登记适配器，未知插件或版本返回空。
 */
function get(name: string, exactVersion: string): Adapter | null {
  return (
    [codeSnippetsAdapter, aiHelperAdapter].find(
      (adapter) => adapter.name === name && adapter.pluginVersion === exactVersion
    ) ?? null
  )
}

export const adapterRegistry: AdapterLookup = { get }
