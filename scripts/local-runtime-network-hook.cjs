/* eslint-disable @typescript-eslint/no-require-imports -- Electron -r 预加载要求 CommonJS，不能推迟到业务 ESM 导入之后。 */
/* eslint-disable @typescript-eslint/explicit-function-return-type -- 预加载 JavaScript 使用 JSDoc 声明返回类型。 */
'use strict'

const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const { app, net, session } = require('electron')
const logPath = process.env.CAI_RUNTIME_AUDIT_LOG
if (!logPath) throw new Error('CAI_RUNTIME_AUDIT_LOG is required')

/**
 * 只记录请求目标，丢弃查询、正文、用户信息及认证头。
 * @param {string} source 请求通道。
 * @param {unknown} input URL 或 Node 请求选项。
 * @returns {void} 无返回值。
 */
function record(source, input) {
  let url
  try {
    if (typeof input === 'string' || input instanceof URL) url = new URL(String(input))
    else if (input?.url) url = new URL(input.url)
    else {
      const protocol = input?.protocol || (source.startsWith('node.https') ? 'https:' : 'http:')
      url = new URL(
        `${protocol}//${input?.hostname || input?.host || 'localhost'}${input?.port ? ':' + input.port : ''}${input?.path || '/'}`
      )
    }
    fs.appendFileSync(
      logPath,
      JSON.stringify({
        time: new Date().toISOString(),
        source,
        origin: url.origin,
        path: url.pathname
      }) + '\n'
    )
  } catch {
    // 无法解析的目标也留下计数，不输出原始输入以免泄漏凭据。
    fs.appendFileSync(
      logPath,
      JSON.stringify({ time: new Date().toISOString(), source, origin: 'unparsed', path: '' }) +
        '\n'
    )
  }
}

/**
 * 观察网络入口后原样调用实现，不阻断或改写请求。
 * @param {object} owner API 所属对象。
 * @param {string} key API 名称。
 * @param {string} source 日志通道名称。
 * @returns {void} 无返回值。
 */
function observe(owner, key, source) {
  const original = owner[key]
  /**
   * 转发一次请求并保留原调用上下文。
   * @param {...unknown} args 原始调用参数。
   * @returns {unknown} 原方法返回值。
   */
  owner[key] = function (...args) {
    record(source, args[0])
    return Reflect.apply(original, this, args)
  }
}

observe(globalThis, 'fetch', 'node.fetch')
observe(http, 'request', 'node.http.request')
observe(http, 'get', 'node.http.get')
observe(https, 'request', 'node.https.request')
observe(https, 'get', 'node.https.get')
observe(net, 'request', 'electron.net.request')
observe(net, 'fetch', 'electron.net.fetch')
const seen = new WeakSet()

/**
 * 为新会话注册观察器，覆盖默认、持久化和临时分区。
 * @param {Electron.Session} current 新创建的会话。
 * @returns {void} 无返回值。
 */
function observeSession(current) {
  if (seen.has(current)) return
  seen.add(current)
  // 当前应用没有其它 onBeforeRequest 订阅；只记录并始终放行。
  current.webRequest.onBeforeRequest((details, callback) => {
    record('session.webRequest', details.url)
    callback({ cancel: false })
  })
}

app.on('session-created', observeSession)
void app.whenReady().then(() => observeSession(session.defaultSession))

/**
 * 用本机服务证明每条观察通道和新会话都已生效。
 * @param {string} base 本机自检服务 URL。
 * @returns {Promise<void>} 所有自检请求结束后的 Promise。
 */
globalThis.__caiAuditSelfCheck = async function (base) {
  await fetch(base + '/node-fetch?secret=must-not-be-logged')
  await new Promise((resolve, reject) =>
    http
      .get(base + '/node-http-get', (response) => {
        response.resume()
        response.on('end', resolve)
      })
      .on('error', reject)
  )
  await new Promise((resolve, reject) => {
    const request = http.request(base + '/node-http-request', (response) => {
      response.resume()
      response.on('end', resolve)
    })
    request.on('error', reject)
    request.end()
  })
  // HTTPS 对本机 HTTP 服务握手失败也是一次可观测请求，避免访问第三方自检站点。
  await new Promise((resolve) =>
    https.get(base.replace('http:', 'https:') + '/node-https-get').on('error', resolve)
  )
  await new Promise((resolve) => {
    const request = https.request(base.replace('http:', 'https:') + '/node-https-request')
    request.on('error', resolve)
    request.end()
  })
  await net.fetch(base + '/electron-fetch')
  await new Promise((resolve, reject) => {
    const request = net.request(base + '/electron-request')
    request.on('response', (response) => {
      response.on('data', () => {})
      response.on('end', resolve)
    })
    request.on('error', reject)
    request.end()
  })
  await session.fromPartition('audit-self-check').fetch(base + '/new-session')
}

// -r 预加载在业务入口之前执行；驱动程序必须验证该标记和完整通道自检。
fs.appendFileSync(
  logPath,
  JSON.stringify({
    time: new Date().toISOString(),
    source: 'audit.initialized',
    e2e: process.env.ZTOOLS_E2E || null,
    businessLoaded: Object.keys(require.cache).some((key) => /out[\\/]main[\\/]/.test(key))
  }) + '\n'
)
