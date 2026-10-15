import { UPSTREAM_BASE_VERSION, type UpstreamNotice } from '../../../shared/localEdition'

const UPSTREAM_RELEASE_API = 'https://api.github.com/repos/ZToolsCenter/ZTools/releases/latest'
const UPSTREAM_RELEASE_ROOT = 'https://github.com/ZToolsCenter/ZTools/releases/'

/**
 * 将上游稳定版本解析为三个安全整数，拒绝预览版和本地版本后缀。
 * @param version 上游标签或基线版本，仅允许可选 v 前缀和三个数字段。
 * @returns 主版本、次版本、补丁版本组成的元组。
 * @throws 格式不符或数字超出安全整数范围时抛出 INVALID_STABLE_VERSION。
 */
export function parseStableVersion(version: string): [number, number, number] {
  // 同时检查完整匹配，避免正则末尾锚点接受最终换行符。
  const match = typeof version === 'string' ? /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version) : null
  if (!match || match[0] !== version) throw new Error('INVALID_STABLE_VERSION')
  const parts = match.slice(1).map(Number)
  if (!parts.every(Number.isSafeInteger)) throw new Error('INVALID_STABLE_VERSION')
  return parts as [number, number, number]
}

/**
 * 逐段比较上游稳定版本，避免字典序或本地构建后缀影响判断。
 * @param candidate 待比较的上游稳定版本。
 * @param baseline 本机使用的上游基线版本。
 * @returns 候选版本严格较新时返回 true。
 * @throws 任一版本无效时抛出 INVALID_STABLE_VERSION。
 */
export function isNewerStableVersion(candidate: string, baseline: string): boolean {
  const candidateParts = parseStableVersion(candidate)
  const baselineParts = parseStableVersion(baseline)
  // 较高版本段一旦不同，就不能让后续较低段反转比较结果。
  for (let index = 0; index < 3; index++) {
    if (candidateParts[index] !== baselineParts[index]) {
      return candidateParts[index] > baselineParts[index]
    }
  }
  return false
}

/**
 * 校验系统浏览器可打开的上游发布页，排除下载附件和非稳定标签。
 * @param value API 或渲染进程提供的未知地址。
 * @returns 地址为固定仓库的 HTTPS 稳定版发布页或 latest 时返回 true。
 */
export function isAllowedUpstreamReleaseUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const target = new URL(value)
    // 不接受凭据、查询参数、片段或 URL 解析器规范化后才落入白名单的输入。
    if (
      target.origin !== 'https://github.com' ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      target.href !== value ||
      !value.startsWith(UPSTREAM_RELEASE_ROOT)
    )
      return false
    const suffix = value.slice(UPSTREAM_RELEASE_ROOT.length)
    if (suffix === 'latest') return true
    if (!suffix.startsWith('tag/')) return false
    parseStableVersion(suffix.slice('tag/'.length))
    return true
  } catch {
    return false
  }
}

/**
 * 按用户请求读取唯一的 GitHub 最新发布接口并生成只读版本提醒。
 * @returns 可用、已是最新或暂时无法检查的提醒结果；网络及响应错误不会外抛。
 */
export async function checkUpstreamUpdate(): Promise<UpstreamNotice> {
  try {
    // 禁止跟随跳转，所有检查仅向固定接口发送一次限时 GET 请求。
    const response = await fetch(UPSTREAM_RELEASE_API, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CAI.Tools' }
    })
    if (!response.ok) {
      return { kind: 'unavailable', message: `暂时无法检查上游版本（HTTP ${response.status}）` }
    }
    const release: unknown = await response.json()
    // 发布标志和必要字段均来自远端，未知格式或预览内容不能成为更新提醒。
    if (!release || typeof release !== 'object') {
      return { kind: 'unavailable', message: '上游发布信息无效' }
    }
    const { tag_name, html_url, draft, prerelease } = release as Record<string, unknown>
    if (
      draft !== false ||
      prerelease !== false ||
      typeof tag_name !== 'string' ||
      !isAllowedUpstreamReleaseUrl(html_url)
    ) {
      return { kind: 'unavailable', message: '上游发布信息不是可信的稳定版本' }
    }
    const version = parseStableVersion(tag_name).join('.')
    // 标签页必须对应返回的版本，防止远端信息把版本和另一发布页面混用。
    if (
      html_url !== `${UPSTREAM_RELEASE_ROOT}latest` &&
      parseStableVersion(html_url.slice(`${UPSTREAM_RELEASE_ROOT}tag/`.length)).join('.') !==
        version
    ) {
      return { kind: 'unavailable', message: '上游发布页与版本不一致' }
    }
    return {
      kind: isNewerStableVersion(version, UPSTREAM_BASE_VERSION) ? 'available' : 'up-to-date',
      version,
      releaseUrl: html_url
    }
  } catch {
    // 离线、超时、限流之外的响应错误也只影响本次查询，不创建后台重试任务。
    return { kind: 'unavailable', message: '暂时无法检查上游版本，请稍后手动重试' }
  }
}
