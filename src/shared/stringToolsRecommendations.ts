interface TextToolCommand {
  path: string
  pluginName?: string
  featureCode?: string
  cmdType?: string
  matchCmd?: { type?: string }
}

/**
 * 计算字符串插件匹配入口的相对优先级，通用入口在具体工具之后。
 * @param command 已满足文本条件的命令。
 * @returns 解码、SQL、行整理、命名及通用入口的相对权重。
 */
function getToolPriority(command: TextToolCommand): number {
  if ((command.cmdType ?? command.matchCmd?.type) === 'over') return 0
  const priorities: Record<string, number> = { unicode: 4, sql: 3, lines: 2, case: 1 }
  return priorities[command.featureCode ?? ''] ?? 0
}

/**
 * 仅在同一个字符串插件的匹配项原位置内排序，保留其他插件和手动入口的顺序。
 * @param results 已匹配并按宿主规则排序的命令。
 * @returns 不修改原数组的结果，Unicode 解码优先于其他字符串工具。
 */
export function prioritizeStringToolMatches<T extends TextToolCommand>(results: T[]): T[] {
  const positions = new Map<string, number[]>()
  const ordered = [...results]

  // 按插件路径分组，开发版和正式版即使同时存在也不交换彼此的位置。
  for (const [index, command] of results.entries()) {
    if (!['string-tools', 'string-tools__dev'].includes(command.pluginName ?? '')) continue
    if (!['regex', 'over'].includes(command.cmdType ?? command.matchCmd?.type ?? '')) continue
    const indexes = positions.get(command.path) ?? []
    indexes.push(index)
    positions.set(command.path, indexes)
  }

  // 只替换该插件自己的槽位，保留第三方命令、相同优先级和用户手动搜索的相对次序。
  for (const indexes of positions.values()) {
    const tools = indexes
      .map((index) => results[index])
      .sort((a, b) => getToolPriority(b) - getToolPriority(a))
    indexes.forEach((index, offset) => {
      ordered[index] = tools[offset]
    })
  }
  return ordered
}
