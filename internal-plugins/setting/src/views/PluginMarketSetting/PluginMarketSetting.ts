import { router } from '@/router'
import type { TabId } from '@/components'

/** 跳转到插件市场页面的参数，旧评论定位字段仅作为兼容输入。 */
export interface PluginMarketSettingJumpFunction {
  /** 自动打开详情的插件名称或搜索词。 */
  payload?: string
  /** over 表示填入搜索框，detail 表示打开插件详情。 */
  type?: 'over' | 'detail' | string
  /** 标签输入会归一化，旧评论标签回到详情页。 */
  tab?: string
  /** 兼容旧调用方；本地版忽略评论定位。 */
  commentId?: number
}

/**
 * 将外部或旧版跳转标签限制到市场详情可用范围。
 * @param tab 外部传入的标签名称。
 * @returns 可用的市场详情标签，未知输入回退到详情。
 */
export function normalizePluginMarketTab(tab: unknown): TabId {
  // 旧评论和未知标签均回退到可阅读的详情内容。
  return tab === 'releases' || tab === 'data' ? tab : 'detail'
}

/**
 * 跳转到插件市场，并清理旧评论定位状态。
 * @param config 路由状态参数。
 * @returns 无返回值。
 */
export function jumpFunctionPluginMarketSetting(config: PluginMarketSettingJumpFunction): void {
  // 只转交本地版使用的字段，防止旧历史状态恢复评论面板。
  void router.replace({
    name: 'Market',
    query: { _t: Date.now() },
    state: {
      payload: config.payload,
      type: config.type,
      tab: normalizePluginMarketTab(config.tab)
    }
  })
}
