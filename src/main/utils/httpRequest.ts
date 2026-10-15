import { net, session } from 'electron'
import { IncomingMessage } from 'electron'

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'HEAD' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  body?: string | URLSearchParams
  maxRedirects?: number
  /** 整个请求的超时毫秒数；未设置或非正有限值时不增加超时限制。 */
  timeout?: number
  validateStatus?: (status: number) => boolean
}

export interface HttpResponse {
  data: any
  status: number
  statusMessage: string
  headers: Record<string, string | string[]>
  request?: {
    res?: {
      responseUrl?: string
    }
  }
}

/**
 * 使用 Electron net.request 发送 HTTP 请求
 * 注意: 代理配置已在全局 session 上设置，所有请求自动使用代理
 * 默认禁用缓存，确保每次都获取最新数据
 * @param url 请求的完整地址。
 * @param options 方法、请求头、正文、状态校验及可选的总超时。
 * @returns 成功响应；HTTP、传输、中止或超时错误时拒绝的 Promise。
 */
export function httpRequest(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const {
      method = 'GET',
      headers = {},
      body,
      timeout,
      validateStatus = (status) => status >= 200 && status < 300
    } = options
    let settled = false
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined

    /**
     * 只结算一次请求，并释放总超时计时器。
     * @param outcome 已完成的响应或请求错误。
     * @returns 无返回值。
     */
    const finish = (outcome: HttpResponse | Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      if (outcome instanceof Error) reject(outcome)
      else resolve(outcome)
    }

    // 默认禁用缓存的请求头（用户传入的 headers 可以覆盖）
    const defaultHeaders = {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      ...headers // 用户自定义的 headers 会覆盖默认值
    }

    const finalUrl = url

    /**
     * 创建 Electron 请求，并为成功、失败及取消统一释放资源。
     * @param requestUrl 请求地址。
     * @returns 无返回值。
     * @throws Electron 无法创建请求时抛出错误，由外层 Promise 拒绝。
     */
    const makeRequest = (requestUrl: string): void => {
      const request = net.request({
        method,
        url: requestUrl,
        redirect: 'follow', // 自动跟随重定向（manual 模式在某些 Electron 版本会导致 Redirect was cancelled 错误）
        session: session.defaultSession // 显式指定使用 defaultSession（确保代理配置生效）
      })

      try {
        // 设置请求头（包含默认的禁用缓存头）
        Object.entries(defaultHeaders).forEach(([key, value]) => {
          request.setHeader(key, value)
        })

        // 处理响应
        request.on('response', (response: IncomingMessage) => {
          const chunks: Buffer[] = []
          const responseHeaders: Record<string, string | string[]> = {}

          // 收集响应头
          Object.entries(response.headers).forEach(([key, value]) => {
            responseHeaders[key] = value
          })

          // 收集响应数据
          response.on('data', (chunk: Buffer) => {
            if (!settled) chunks.push(chunk)
          })

          response.on('end', () => {
            if (settled) return
            const buffer = Buffer.concat(chunks)
            let data: any

            // 根据 Content-Type 解析数据
            const contentType = response.headers['content-type']
            const contentTypeStr = Array.isArray(contentType) ? contentType[0] : contentType

            if (contentTypeStr?.includes('application/json')) {
              try {
                data = JSON.parse(buffer.toString('utf-8'))
              } catch {
                data = buffer.toString('utf-8')
              }
            } else {
              data = buffer.toString('utf-8')
            }

            const httpResponse: HttpResponse = {
              data,
              status: response.statusCode || 0,
              statusMessage: response.statusMessage || '',
              headers: responseHeaders,
              request: {
                res: {
                  responseUrl: finalUrl
                }
              }
            }

            // 验证状态码
            try {
              if (validateStatus(httpResponse.status)) {
                finish(httpResponse)
              } else {
                finish(
                  new Error(
                    `Request failed with status code ${httpResponse.status}: ${httpResponse.statusMessage}`
                  )
                )
              }
            } catch (error) {
              finish(error instanceof Error ? error : new Error(String(error)))
            }
          })

          response.on('error', (error: Error) => {
            finish(error)
          })
        })

        // 处理请求错误
        request.on('error', (error: Error) => {
          finish(error)
        })

        // 主动取消有时只产生 abort 事件，必须让等待响应的调用方及时退出。
        request.on('abort', () => {
          finish(Object.assign(new Error('HTTP request aborted'), { code: 'ABORT_ERR' }))
        })
        if (Number.isFinite(timeout) && (timeout ?? 0) > 0) {
          timeoutHandle = setTimeout(() => {
            // 先固定超时结果，再取消底层请求，避免 abort/error 事件覆盖错误语义。
            finish(
              Object.assign(new Error(`HTTP request timed out after ${timeout}ms`), {
                code: 'ETIMEDOUT'
              })
            )
            request.abort()
          }, timeout)
        }

        // 发送请求体
        if (body) {
          if (body instanceof URLSearchParams) {
            request.write(body.toString())
          } else {
            request.write(body)
          }
        }

        // 结束请求
        request.end()
      } catch (error) {
        // 发送准备阶段的同步错误也必须清理已经建立的超时计时器。
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }

    makeRequest(url)
  })
}

/**
 * GET 请求
 */
export function httpGet(
  url: string,
  options: Omit<HttpRequestOptions, 'method'> = {}
): Promise<HttpResponse> {
  return httpRequest(url, { ...options, method: 'GET' })
}

/**
 * POST 请求
 */
export function httpPost(
  url: string,
  body?: string | URLSearchParams,
  options: Omit<HttpRequestOptions, 'method' | 'body'> = {}
): Promise<HttpResponse> {
  return httpRequest(url, { ...options, method: 'POST', body })
}

/**
 * HEAD 请求
 */
export function httpHead(
  url: string,
  options: Omit<HttpRequestOptions, 'method'> = {}
): Promise<HttpResponse> {
  return httpRequest(url, { ...options, method: 'HEAD' })
}
