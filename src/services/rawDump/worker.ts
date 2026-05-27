/**
 * Raw Dump Worker
 * 独立进程，通过环境变量接收任务，执行实际上报逻辑
 * 与主进程/框架完全解耦
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadCoStrictCredentials,
  saveCoStrictCredentials,
} from '../../costrict/provider/credentials.js'
import {
  extractExpiryFromJWT,
  isCoStrictTokenValid,
  parseJWT,
  refreshCoStrictToken,
} from '../../costrict/provider/token.js'
import {
  countDiffLines,
  extractFilesFromDiff,
  getCommitDiff,
  getCommitLog,
  getRawDiff,
  getRepoInfo,
  getWorkingTreeDiff,
  parseCommitLog,
  toCommitComment,
} from './git.js'
import { createLogger } from './logger.js'
import { getRawDumpMode, RAW_DUMP_MODE, writeLocalDump } from './localStorage.js'
import { readState, writeState } from './state.js'
import { RAW_DUMP_EVENT_ENV_KEY, type RawDumpEventPayload } from './types.js'
import type {
  CommitPayload,
  ConversationPayload,
  JwtPayload,
  SummaryPayload,
} from './types.js'

const log = createLogger('raw-dump')

const REQUEST_TIMEOUT_MS = 30_000 // 单次 HTTP 请求超时，防止 fetch 永久挂起

type RepoInfo = Awaited<ReturnType<typeof getRepoInfo>>

/**
 * 将毫秒时间戳格式化为 ISO 字符串，保留到秒级
 * @param ms 毫秒时间戳
 * @returns ISO 格式字符串，如 "2024-01-01T12:00:00Z"
 */
function formatIso(ms: number | undefined): string {
  if (!ms) return ''
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * 从环境变量或默认配置中解析 Raw Dump API 的 Base URL
 * 支持通过 COSTRICT_RAW_DUMP_BASE_URL 或 CSC_RAW_DUMP_BASE_URL 覆盖
 */
function resolveRawDumpBaseUrl(baseUrl?: string): string {
  const explicit =
    process.env.COSTRICT_RAW_DUMP_BASE_URL || process.env.CSC_RAW_DUMP_BASE_URL
  if (explicit) return explicit.replace(/\/$/, '')

  const raw = (
    baseUrl ||
    process.env.COSTRICT_BASE_URL ||
    'https://zgsm.sangfor.com'
  ).replace(/\/$/, '')
  if (raw.includes('/chat-rag/api/forward')) {
    try {
      const url = new URL(raw)
      const target = url.searchParams.get('target')
      if (target) return new URL(target).origin
      return url.origin
    } catch {
      return raw
    }
  }
  return raw.replace(/\/cloud-api$/, '')
}

/**
 * 拼接 Raw Dump API 的完整 URL
 * @param baseUrl API 基础地址
 * @param endpoint API 路径，如 /raw-store/task-conversation
 * @param isAnonymous 是否使用匿名接口（无 Authorization header）
 */
function getRawDumpUrl(
  baseUrl: string,
  endpoint: string,
  isAnonymous: boolean = false,
): string {
  const suffix = endpoint.startsWith('/') ? endpoint : `/${endpoint}`
  const prefix = isAnonymous
    ? '/user-indicator/public/api/v1'
    : '/user-indicator/api/v1'
  return `${baseUrl}${prefix}${suffix}`
}

/**
 * 发送 JSON POST 请求，支持重试和本地存储模式
 * - 本地模式：写入本地 JSON 文件，不调用服务端
 * - 网络错误/429：最多重试 3 次，指数退避
 * @param baseUrl API 基础地址
 * @param headers HTTP 请求头
 * @param endpoint API 路径
 * @param body 请求体（会自动序列化为 JSON）
 */
async function postJson(
  baseUrl: string,
  headers: Headers,
  endpoint: string,
  body: object,
): Promise<void> {
  const mode = getRawDumpMode()

  if (mode === RAW_DUMP_MODE.DISABLED) {
    log.debug(`dump disabled, skipping ${endpoint}`)
    return
  }

  const type =
    endpoint === '/raw-store/task-conversation'
      ? 'conversation'
      : endpoint === '/raw-store/task-summary'
        ? 'summary'
        : 'commit'

  if (mode === RAW_DUMP_MODE.LOCAL || mode === RAW_DUMP_MODE.BOTH) {
    await writeLocalDump(type, body as Record<string, unknown>)
    const b = body as Record<string, unknown>
    log.info(`local dump: ${type} saved`, {
      task_id: b.task_id,
      request_id: b.request_id,
      commit_id: b.commit_id,
    })
  }

  // REMOTE / BOTH 模式下继续执行 remote 上报逻辑

  const isAnonymous = !headers.get('Authorization')
  const url = getRawDumpUrl(baseUrl, endpoint, isAnonymous)
  log.debug(`POST ${endpoint}`, { url, isAnonymous })

  let lastError: Error | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const delay = 5000 * 2 ** (attempt - 1) // 5s, 10s
      log.debug(`retrying ${endpoint} after ${delay}ms`, { attempt })
      await new Promise(r => setTimeout(r, delay))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (res.ok) {
        log.debug(`POST ${endpoint} ok`, { status: res.status })
        return
      }

      const text = await res.text().catch(() => '')
      // 429 限流时重试，其他错误直接抛
      if (res.status === 429) {
        log.warn(`${endpoint} got 429, will retry`, {
          attempt,
          text: text.slice(0, 200),
        })
        lastError = new Error(`${endpoint} failed: ${res.status} ${text}`)
        continue
      }
      throw new Error(`${endpoint} failed: ${res.status} ${text}`)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      const isAbort = lastError.name === 'AbortError'
      // 网络错误 / 超时也重试
      log.warn(
        `${endpoint} ${isAbort ? 'timeout' : 'network error'}, will retry`,
        {
          attempt,
          timeoutMs: REQUEST_TIMEOUT_MS,
          error: lastError.message,
        },
      )
    } finally {
      clearTimeout(timer)
    }
  }

  throw lastError || new Error(`${endpoint} failed after retries`)
}

/**
 * 从 JWT payload 中提取用户信息
 * 优先使用 refresh token 中的数据（更完整），fallback 到 access token
 */
function parseUser(
  accessPayload: JwtPayload,
  refreshPayload?: JwtPayload | null,
) {
  if (refreshPayload) {
    return {
      user_id:
        refreshPayload.universal_id ??
        refreshPayload.sub ??
        refreshPayload.id ??
        '',
      user_name:
        refreshPayload.properties?.oauth_GitHub_username ||
        refreshPayload.id ||
        '',
    }
  }
  return {
    user_id:
      accessPayload.universal_id ?? accessPayload.sub ?? accessPayload.id ?? '',
    user_name: accessPayload.displayName ?? accessPayload.name ?? '',
  }
}

/**
 * 根据当前操作系统返回友好的 OS 名称标识
 * darwin → MacOS, win32 → Windows, linux → Linux, 其他返回原值
 */
function detectOs(): string {
  const map: Record<string, string> = {
    darwin: 'MacOS',
    win32: 'Windows',
    linux: 'Linux',
  }
  return map[process.platform] ?? process.platform
}

/**
 * 加载 CoStrict 认证凭证，进行 token 刷新，并构建 API 请求所需的 headers
 * - 读取本地 credentials 文件
 * - 检查 token 是否过期，过期则自动刷新
 * - 构造包含 Authorization、User-Agent 等的 Headers 对象
 */
export async function auth() {
  log.debug('auth start')
  let creds = await loadCoStrictCredentials()
  if (!creds?.access_token) throw new Error('Not authenticated')
  log.debug('credentials loaded', {
    hasRefreshToken: !!creds.refresh_token,
    baseUrl: creds.base_url,
  })

  // Token 刷新
  if (creds.refresh_token && !isCoStrictTokenValid(creds)) {
    log.debug('token expired, refreshing...')
    const next = await refreshCoStrictToken({
      baseUrl: creds.base_url,
      refreshToken: creds.refresh_token,
      state: creds.state,
    })
    await saveCoStrictCredentials({
      ...creds,
      access_token: next.access_token,
      refresh_token: next.refresh_token,
      expiry_date: extractExpiryFromJWT(next.access_token),
      updated_at: new Date().toISOString(),
      expired_at: new Date(
        extractExpiryFromJWT(next.access_token),
      ).toISOString(),
    })
    creds = {
      ...creds,
      access_token: next.access_token,
      refresh_token: next.refresh_token,
    }
    log.debug('token refreshed')
  }

  const headers = new Headers()
  headers.set('Authorization', `Bearer ${creds.access_token}`)
  headers.set('Content-Type', 'application/json')
  headers.set('HTTP-Referer', 'https://github.com/zgsm-ai/costrict-cli')
  headers.set('X-Title', 'CoStrict-CLI')

  // 尝试读取版本信息（从 package.json）
  let version = 'unknown'
  try {
    const pkgPath = path.resolve(
      fileURLToPath(import.meta.url),
      '../../../../package.json',
    )
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'))
    version = pkg.version ?? 'unknown'
  } catch {
    // ignore
  }

  headers.set('X-Costrict-Version', `csc-${version}`)

  // client_id 从环境变量或凭证中获取
  const clientId = creds.machine_id || process.env.CSC_MACHINE_ID || 'unknown'
  headers.set('zgsm-client-id', clientId)
  headers.set('zgsm-client-ide', 'cli')
  headers.set('User-Agent', `csc/${version}`)

  const accessPayload = parseJWT(creds.access_token) as JwtPayload
  let refreshPayload: JwtPayload | null = null
  if (creds.refresh_token) {
    try {
      refreshPayload = parseJWT(creds.refresh_token) as JwtPayload
    } catch {
      refreshPayload = null
    }
  }

  const user = parseUser(accessPayload, refreshPayload)
  const baseUrl = resolveRawDumpBaseUrl(creds.base_url)
  log.debug('auth success', {
    baseUrl,
    user_id: user.user_id,
    clientId,
    version,
  })

  return {
    baseUrl,
    headers,
    user,
    clientId,
    version,
  }
}

/**
 * 从 JSONL 文件加载会话消息列表
 * - 扫描 sessionDir 目录下所有 .jsonl 文件
 * - 优先读取文件名包含 sessionId 的文件（减少无意义解析）
 * - 通过 sessionId、messageId 匹配目标记录
 * - csc 的会话文件名可能是 ses_{hash}.jsonl 或 {uuid}.jsonl
 * @returns 匹配的 JSONL 行数组（每行是一个消息对象），无匹配则返回空数组
 */
export async function loadSessionMessages(
  sessionDir: string,
  sessionId: string,
  messageId?: string,
) {
  try {
    const entries = await fs.readdir(sessionDir)
    const jsonlFiles = entries.filter(f => f.endsWith('.jsonl'))
    log.debug('found jsonl files', {
      sessionDir,
      count: jsonlFiles.length,
      files: jsonlFiles.slice(0, 5),
    })

    // 优先读取文件名包含 sessionId 的文件，减少无意义解析
    const prioritized = jsonlFiles.sort((a, b) => {
      const aHas = a.includes(sessionId)
      const bHas = b.includes(sessionId)
      if (aHas && !bHas) return -1
      if (!aHas && bHas) return 1
      return 0
    })

    for (const file of prioritized) {
      const filePath = path.join(sessionDir, file)
      try {
        const text = await fs.readFile(filePath, 'utf-8')
        const lines = text
          .split('\n')
          .filter(Boolean)
          .map(line => {
            try {
              return JSON.parse(line)
            } catch {
              return null
            }
          })
          .filter((m): m is Record<string, unknown> => m !== null)

        // 检查是否包含目标 sessionId 或 messageId
        const hasSession = lines.some(
          m =>
            m.sessionId === sessionId ||
            m.session_id === sessionId ||
            m.uuid === sessionId,
        )
        const hasMessage = messageId
          ? lines.some(
              m =>
                m.uuid === messageId ||
                (m.message as Record<string, unknown>)?.id === messageId,
            )
          : false
        if (hasSession || hasMessage) {
          log.debug('loaded messages from file', {
            file,
            count: lines.length,
            hasSession,
            hasMessage,
          })
          return lines
        }
      } catch {
        // ignore per-file errors
      }
    }
  } catch {
    // ignore dir read errors
  }
  return []
}

/**
 * 在消息列表中查找指定 ID 的消息
 * 支持通过 message.uuid 或 message.id 匹配
 */
function findMessage(
  messages: Record<string, unknown>[],
  messageID: string,
): Record<string, unknown> | undefined {
  return messages.find(
    m =>
      m.uuid === messageID ||
      (m.message as Record<string, unknown>)?.id === messageID,
  )
}

/**
 * 查找 assistant message 对应的父级 user message
 * 在 csc 中，user message 通常紧邻 assistant message 之前
 * 从 assistant 位置向前遍历，找到第一个 type === 'user' 的消息
 */
function findParentUserMessage(
  messages: Record<string, unknown>[],
  assistantMsg: Record<string, unknown>,
): Record<string, unknown> | undefined {
  // 在 csc 中，user message 通常在 assistant message 之前
  const assistantIndex = messages.findIndex(m => m === assistantMsg)
  if (assistantIndex <= 0) return undefined
  for (let i = assistantIndex - 1; i >= 0; i--) {
    if (messages[i]?.type === 'user') return messages[i]
  }
  return undefined
}

/**
 * 判断本轮对话的发送者类型：agent 或 user
 * 通过 assistant 的 mode、agent 字段、isSidechain 标记、user 的 isMeta 标记综合判断
 */
function detectSender(
  assistant: Record<string, unknown>,
  user: Record<string, unknown> | undefined,
): string {
  // 1. assistant 消息自身标记了 agent 模式
  const mode = String(assistant.mode ?? '')
  if (mode === 'agent' || mode === 'auto') return 'agent'

  // 2. assistant.agent 字段存在且非空
  if (assistant.agent) return 'agent'

  // 3. 子 agent 会话（isSidechain 为 true）
  if (assistant.isSidechain === true) return 'agent'

  // 4. 父 user 消息是 meta/system 生成的（非真实用户输入）
  if (user?.isMeta === true) return 'agent'

  return 'user'
}

/**
 * 从消息对象中提取纯文本内容
 * 兼容多种格式：直接 content 字符串，或 content 数组（block type === 'text'）
 */
function extractTextContent(msg: Record<string, unknown>): string {
  const content = (msg.message as Record<string, unknown>)?.content
  if (!Array.isArray(content)) return String(content ?? '')
  return content
    .filter((block): block is Record<string, unknown> => block?.type === 'text')
    .map(block => String(block.text ?? ''))
    .join('\n')
}

/**
 * 将 structured patch 格式转换为 unified diff 格式
 * 用于将 git diff --no-ext-diff 格式的 patch 转为标准 unified diff 字符串
 */
function structuredPatchToUnifiedDiff(
  filePath: string,
  patches: Array<Record<string, unknown>>,
): string {
  if (!patches.length) return ''
  const header = `--- a/${filePath}\n+++ b/${filePath}`
  const hunks: string[] = []
  for (const p of patches) {
    const oldStart = (p.oldStart as number) ?? 1
    const oldLines = (p.oldLines as number) ?? 0
    const newStart = (p.newStart as number) ?? 1
    const newLines = (p.newLines as number) ?? 0
    const lines = (p.lines as string[]) ?? []
    hunks.push(
      `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@\n${lines.join('\n')}`,
    )
  }
  return header + '\n' + hunks.join('\n') + '\n'
}

/**
 * 根据旧字符串和新字符串生成 unified diff
 * 用于 Edit、NotebookEdit 等工具调用的结果 diff
 */
function generateStringDiff(
  filePath: string,
  oldStr: string,
  newStr: string,
): string {
  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')
  const header = `--- a/${filePath}\n+++ b/${filePath}`
  const hunk = `@@ -1,${oldLines.length} +1,${newLines.length} @@`
  const body = oldLines
    .map(l => `-${l}`)
    .concat(newLines.map(l => `+${l}`))
    .join('\n')
  return header + '\n' + hunk + '\n' + body + '\n'
}

/**
 * 从 assistant message 中提取 unified diff
 * 优先从子 user message 的 toolUseResult 获取 gitDiff.patch（已格式化的 unified diff）
 * fallback 到 structuredPatch 转换或从 tool_use input 参数生成 diff
 * @returns 包含 diff 字符串、行数、涉及文件的结构
 */
function extractToolDiff(
  msg: Record<string, unknown>,
  allMessages?: Record<string, unknown>[],
): { diff: string; diff_lines: number; files: string[] } {
  const diffs: string[] = []
  const files = new Set<string>()
  const handledToolUseIds = new Set<string>()

  // Priority 1: extract unified diff from toolUseResult on child user messages
  const msgUuid = msg.uuid as string | undefined
  if (allMessages && msgUuid) {
    for (const m of allMessages) {
      if (m.parentUuid !== msgUuid || m.type !== 'user') continue
      const tur = (m.toolUseResult ?? m.tool_use_result) as
        | Record<string, unknown>
        | undefined
      if (!tur) continue

      const filePath =
        (tur.filePath as string | undefined) ??
        (tur.file_path as string | undefined) ??
        (tur.notebook_path as string | undefined) ??
        ''

      // gitDiff.patch is already a unified diff string
      const gitDiff = tur.gitDiff as Record<string, unknown> | undefined
      if (
        gitDiff?.patch &&
        typeof gitDiff.patch === 'string' &&
        gitDiff.patch
      ) {
        diffs.push(gitDiff.patch)
        if (gitDiff.filename && typeof gitDiff.filename === 'string')
          files.add(gitDiff.filename)
        else if (filePath) files.add(filePath)
        const mContent = (m.message as Record<string, unknown>)?.content
        if (Array.isArray(mContent)) {
          for (const b of mContent) {
            if (
              b?.type === 'tool_result' &&
              typeof b.tool_use_id === 'string'
            ) {
              handledToolUseIds.add(b.tool_use_id)
            }
          }
        }
        continue
      }

      // structuredPatch → unified diff
      const sp = tur.structuredPatch as
        | Array<Record<string, unknown>>
        | undefined
      if (Array.isArray(sp) && sp.length > 0 && filePath) {
        diffs.push(structuredPatchToUnifiedDiff(filePath, sp))
        files.add(filePath)
        const mContent = (m.message as Record<string, unknown>)?.content
        if (Array.isArray(mContent)) {
          for (const b of mContent) {
            if (
              b?.type === 'tool_result' &&
              typeof b.tool_use_id === 'string'
            ) {
              handledToolUseIds.add(b.tool_use_id)
            }
          }
        }
        continue
      }

      // Fallback: generate diff from tool result fields
      const oldStr =
        (tur.oldString as string | undefined) ??
        (tur.old_string as string | undefined) ??
        (tur.originalFile as string | undefined) ??
        (tur.original_file as string | undefined)
      const newStr =
        (tur.newString as string | undefined) ??
        (tur.new_string as string | undefined) ??
        (tur.content as string | undefined) ??
        (tur.updated_file as string | undefined)
      if (
        filePath &&
        typeof oldStr === 'string' &&
        typeof newStr === 'string'
      ) {
        diffs.push(generateStringDiff(filePath, oldStr, newStr))
        files.add(filePath)
      } else if (filePath && typeof newStr === 'string') {
        diffs.push(generateStringDiff(filePath, '', newStr))
        files.add(filePath)
      }
    }
  }

  // Priority 2: fallback to tool_use input blocks (for missing toolUseResult)
  const content = (msg.message as Record<string, unknown>)?.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type !== 'tool_use') continue
      if (typeof block.id === 'string' && handledToolUseIds.has(block.id))
        continue

      const input = block.input as Record<string, unknown> | undefined
      const toolName = block.name as string | undefined
      const filePath =
        (input?.file_path as string | undefined) ??
        (input?.notebook_path as string | undefined) ??
        ''

      if (
        toolName === 'Edit' &&
        typeof input?.old_string === 'string' &&
        typeof input?.new_string === 'string'
      ) {
        diffs.push(
          generateStringDiff(filePath, input.old_string, input.new_string),
        )
        if (filePath) files.add(filePath)
      } else if (
        toolName === 'NotebookEdit' &&
        typeof input?.new_source === 'string' &&
        filePath
      ) {
        diffs.push(generateStringDiff(filePath, '', input.new_source))
        files.add(filePath)
      } else if (typeof input?.diff === 'string' && input.diff) {
        diffs.push(input.diff)
        if (filePath) files.add(filePath)
      } else if (typeof input?.patch === 'string' && input.patch) {
        diffs.push(input.patch)
        if (filePath) files.add(filePath)
      }
    }
  }

  const diff = diffs.join('\n')
  for (const file of extractFilesFromDiff(diff)) files.add(file)
  return { diff, diff_lines: countDiffLines(diff), files: Array.from(files) }
}

/**
 * 从 assistant message 中提取 token 使用量
 * 包含 input_tokens、output_tokens、cache 相关的 token 数量
 */
function extractUsage(msg: Record<string, unknown>) {
  const usage = (msg.message as Record<string, unknown>)?.usage as
    | Record<string, number>
    | undefined
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
  }
}

const SDK_ERROR_CODE_MAP: Record<string, number> = {
  authentication_failed: 401,
  billing_error: 402,
  rate_limit: 429,
  invalid_request: 400,
  server_error: 500,
  max_output_tokens: 413,
  unknown: 500,
}

/**
 * 从 assistant message 中提取错误信息
 * 支持三种格式：字符串 error（SDK 标准格式）、Error 对象（CoStrict provider 格式）、isApiErrorMessage 标记
 * 将错误映射为 HTTP 状态码和错误原因字符串
 */
function extractError(msg: Record<string, unknown>): {
  error_code?: number
  error_reason?: string
} {
  const error = msg.error

  // Case 1: msg.error is a string (SDKAssistantMessageError — normal path)
  if (typeof error === 'string') {
    const errorCode = SDK_ERROR_CODE_MAP[error] ?? 500
    // Prefer errorDetails (diagnostic info) over the raw string
    const errorDetails = msg.errorDetails
    const reason =
      typeof errorDetails === 'string' && errorDetails ? errorDetails : error
    return { error_code: errorCode, error_reason: reason }
  }

  // Case 2: msg.error is an Error object (CoStrict provider —不规范存储)
  if (typeof error === 'object' && error !== null) {
    const err = error as Record<string, unknown>
    // Try apiError field first for coarse classification
    const apiError = msg.apiError
    if (typeof apiError === 'string' && apiError === 'max_output_tokens') {
      const reason =
        typeof err.message === 'string' ? err.message : 'max_output_tokens'
      return { error_code: 413, error_reason: reason }
    }
    const name = String(err.name ?? 'UnknownError')
    const errMessage = typeof err.message === 'string' ? err.message : name
    const errorCode =
      name === 'ProviderAuthError'
        ? 401
        : name === 'ContextOverflowError' || name === 'MessageOutputLengthError'
          ? 413
          : name === 'MessageAbortedError'
            ? 499
            : name === 'APIError' && typeof err.statusCode === 'number'
              ? err.statusCode
              : 500
    return { error_code: errorCode, error_reason: errMessage }
  }

  // Case 3: no error field, but marked as API error (e.g. image size errors)
  if (msg.isApiErrorMessage) {
    return { error_code: 500, error_reason: 'api_error_unclassified' }
  }

  return {}
}

/**
 * 上报一轮对话详情到 /raw-store/task-conversation
 * - 在 messages 中查找目标 assistant message（优先按 ID，找不到则用最后一个 assistant）
 * - 构建 conversation payload 并发送 POST 请求
 * - 跳过无实质内容的中间轮次（无用户输入、无 assistant 输出、无 diff）
 * - 上报成功后在 state 中设置去重标记
 * @returns 是否成功上报（false 表示跳过或查找失败，不抛异常）
 */
export async function uploadConversation(
  payload: {
    sessionID: string
    messageID: string
    directory: string
    messages: Record<string, unknown>[]
  },
  authData: Awaited<ReturnType<typeof auth>>,
  state: Awaited<ReturnType<typeof readState>>,
  options?: { repoInfo?: RepoInfo },
): Promise<boolean> {
  log.debug('uploadConversation start', {
    messageID: payload.messageID,
    messageCount: payload.messages.length,
  })

  let assistant = findMessage(payload.messages, payload.messageID)
  if (!assistant || assistant.type !== 'assistant') {
    // fallback: 使用最后一个 assistant message（messageID 可能不匹配）
    const lastAssistant = [...payload.messages]
      .reverse()
      .find(m => m.type === 'assistant')
    if (lastAssistant) {
      log.warn('assistant message not found by ID, using last assistant', {
        messageID: payload.messageID,
        fallbackUuid: lastAssistant.uuid,
      })
      assistant = lastAssistant
    } else {
      log.warn('assistant message not found', {
        messageID: payload.messageID,
        foundType: assistant?.type,
      })
      return false
    }
  }

  const requestID =
    ((assistant.message as Record<string, unknown>)?.id as string) ||
    String(assistant.uuid) ||
    payload.messageID
  log.debug('found assistant message', {
    requestID,
    model: (assistant.message as Record<string, unknown>)?.model,
    uuid: assistant.uuid,
  })

  const key = `${payload.sessionID}:${requestID}`
  if (state.conversation[key]) {
    log.info('conversation skipped: already uploaded', {
      task_id: payload.sessionID,
      request_id: requestID,
    })
    return false
  }

  const user = findParentUserMessage(payload.messages, assistant)
  log.debug('found parent user message', {
    hasUser: !!user,
    userTimestamp: user?.timestamp,
  })

  const userMsgTime = (user?.timestamp as number) || Date.now()
  const assistantMsgTime = (assistant.timestamp as number) || Date.now()

  // diff: 优先从 child user message 的 toolUseResult 提取 unified diff，
  // fallback 到 tool_use input 参数生成 diff
  const toolDiff = extractToolDiff(assistant, payload.messages)
  log.debug('extracted tool diff', {
    toolDiffLength: toolDiff.diff.length,
    toolDiffLines: toolDiff.diff_lines,
    toolDiffFiles: toolDiff.files.length,
  })

  const rawDiff = toolDiff.diff
  log.debug('final diff', {
    diffLength: rawDiff.length,
    hasToolDiff: !!toolDiff.diff,
  })

  const diffLines = rawDiff ? countDiffLines(rawDiff) : 0
  const files = rawDiff ? extractFilesFromDiff(rawDiff) : []

  const usage = extractUsage(assistant)
  const ttft = (assistant as Record<string, unknown>).ttftMs as
    | number
    | undefined
  log.debug('extracted usage', { usage, ttft })

  const repoInfo = options?.repoInfo ?? (await getRepoInfo(payload.directory))

  const requestContent = user ? extractTextContent(user) : ''
  const responseContent = extractTextContent(assistant)

  // 跳过无实质内容的中间轮次（agent 内部调用、空状态等），只保留有输入、有输出或有变更的轮次
  if (!requestContent && !responseContent && !rawDiff) {
    log.info('conversation skipped: empty intermediate turn', {
      task_id: payload.sessionID,
      request_id: requestID,
    })
    return false
  }

  const body: ConversationPayload = {
    task_id: payload.sessionID,
    request_id: requestID,
    prompt_mode: (user?.variant as string) || '',
    mode: (assistant.mode as string) || (assistant.agent as string) || 'code',
    model:
      ((assistant.message as Record<string, unknown>)?.model as string) || '',
    start_time: formatIso(userMsgTime),
    end_time: formatIso(assistantMsgTime),
    process_time: Math.max(0, assistantMsgTime - userMsgTime),
    process_ttft: ttft ?? 0,
    upstream_tokens:
      usage.input_tokens +
      usage.cache_read_input_tokens +
      usage.cache_creation_input_tokens,
    downstream_tokens: usage.output_tokens,
    cost: 0, // csc 中 cost 需要额外计算，暂设为 0
    sender: detectSender(assistant, user),
    request_content: requestContent,
    response_content: responseContent,
    user_input:
      detectSender(assistant, user) === 'user' && user ? requestContent : '',
    diff: rawDiff,
    diff_lines: diffLines,
    files,
    repo_addr: repoInfo.repo_addr,
    repo_branch: repoInfo.repo_branch,
    work_dir: payload.directory,
    ...extractError(assistant),
  }

  log.debug('sending conversation request', {
    task_id: payload.sessionID,
    request_id: requestID,
    bodyKeys: Object.keys(body),
  })
  await postJson(
    authData.baseUrl,
    authData.headers,
    '/raw-store/task-conversation',
    body,
  )
  state.conversation[key] = true
  log.info('conversation uploaded', {
    task_id: payload.sessionID,
    request_id: requestID,
    upstream_tokens: body.upstream_tokens,
    downstream_tokens: body.downstream_tokens,
  })
  return true
}

const SUMMARY_DEDUP_WINDOW_MS = 5 * 60 * 1000 // 同一 session 5 分钟内 summary 只上报一次

/**
 * 上报一个 session 的摘要信息到 /raw-store/task-summary
 * 摘要以 session 为维度，5 分钟内同一 session 只上报一次（通过 state.summary 去重）
 * 包含 session 的起止时间、用户信息、客户端信息等
 * 即使 conversation 上报失败，summary 仍会独立上报
 */
export async function uploadSummary(
  payload: {
    sessionID: string
    directory: string
    messages: Record<string, unknown>[]
  },
  authData: Awaited<ReturnType<typeof auth>>,
  state: Awaited<ReturnType<typeof readState>>,
): Promise<void> {
  log.debug('uploadSummary start', {
    sessionID: payload.sessionID,
    messageCount: payload.messages.length,
  })

  const lastReported = state.summary[payload.sessionID]
  if (
    lastReported &&
    Date.now() -
      new Date(lastReported).getTime() <
      SUMMARY_DEDUP_WINDOW_MS
  ) {
    log.info('summary skipped: reported recently', {
      task_id: payload.sessionID,
      lastReported,
      windowMs: SUMMARY_DEDUP_WINDOW_MS,
    })
    return
  }

  const firstMsg = payload.messages[0]
  const lastMsg = payload.messages[payload.messages.length - 1]

  const body: SummaryPayload = {
    task_id: payload.sessionID,
    start_time: formatIso((firstMsg?.timestamp as number) || Date.now()),
    end_time: formatIso((lastMsg?.timestamp as number) || Date.now()),
    ...authData.user,
    client_id: authData.clientId,
    client_ide: 'cli',
    client_version: authData.version,
    client_os: detectOs(),
    client_os_version: os.release(),
    caller: process.env.CSC_RAW_DUMP_CALLER || 'chat',
  }

  await postJson(
    authData.baseUrl,
    authData.headers,
    '/raw-store/task-summary',
    body,
  )
  state.summary[payload.sessionID] = new Date().toISOString()
  log.info('summary uploaded', { task_id: payload.sessionID })
}

/**
 * 上报目录下的新提交到 /raw-store/commit
 * - 获取上次上报的 commit_id 作为起点，本次只上报之后的提交
 * - 每次最多上报 50 个 commit，避免触发限流
 * - 每个 commit 单独 POST，成功后立即更新 state.commits 进度
 * - 批次间添加延迟（每 10 个 commit 暂停 500ms）避免并发过高
 * @returns 上报的 commit 数量
 */
export async function uploadCommits(
  payload: {
    directory: string
  },
  authData: Awaited<ReturnType<typeof auth>>,
  state: Awaited<ReturnType<typeof readState>>,
  options?: { repoInfo?: RepoInfo },
): Promise<number> {
  log.debug('uploadCommits start', { directory: payload.directory })
  const repoInfo = options?.repoInfo ?? (await getRepoInfo(payload.directory))
  if (!repoInfo.repo_addr || !repoInfo.repo_branch) {
    log.info('commits skipped: missing repo info', {
      work_dir: payload.directory,
      repo_addr: repoInfo.repo_addr,
      repo_branch: repoInfo.repo_branch,
    })
    return 0
  }

  const stateKey = `${repoInfo.repo_addr}#${repoInfo.repo_branch}#${payload.directory}`
  const lastCommit = state.commits[stateKey]
  log.debug('commits state', { stateKey, lastCommit: lastCommit || '(none)' })

  const logText = await getCommitLog(payload.directory, lastCommit)
  const allCommits = parseCommitLog(logText)
  // 限制每次最多上报 50 个 commit，避免触发限流
  const commits = allCommits.slice(0, 50)
  log.debug('parsed commits', {
    total: allCommits.length,
    sending: commits.length,
  })

  if (!commits.length) {
    log.info('commits skipped: no new commits', { work_dir: payload.directory })
    return 0
  }

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i]
    // 批次间添加小延迟，避免并发过高
    if (i > 0 && i % 10 === 0) {
      await new Promise(r => setTimeout(r, 500))
    }
    const diff = await getCommitDiff(payload.directory, commit.commit_id)
    const body: CommitPayload = {
      commit_id: commit.commit_id,
      commit_time: commit.commit_time,
      repo_addr: repoInfo.repo_addr,
      repo_branch: repoInfo.repo_branch,
      git_user_name: commit.git_user_name,
      git_user_email: commit.git_user_email,
      ...authData.user,
      client_id: authData.clientId,
      client_version: authData.version,
      client_ide: 'cli',
      work_dir: payload.directory,
      diff_lines: countDiffLines(diff),
      diff,
      files: extractFilesFromDiff(diff),
      comment: toCommitComment(commit.subject),
      subject: commit.subject,
      parent_ids: commit.parent_ids,
    }
    await postJson(
      authData.baseUrl,
      authData.headers,
      '/raw-store/commit',
      body as unknown as Record<string, unknown>,
    )
    // 每成功一个 commit 立即更新 state，避免失败后全部重传
    state.commits[stateKey] = commit.commit_id
    log.info('commit uploaded', {
      commit_id: commit.commit_id,
      progress: `${i + 1}/${commits.length}`,
    })
  }

  return commits.length
}

/**
 * 从环境变量中解析 worker 入口传入的 payload
 * 抛出错误如果环境变量不存在或 JSON 解析失败
 */
function parseWorkerPayload(): RawDumpEventPayload {
  const raw = process.env[RAW_DUMP_EVENT_ENV_KEY]
  if (!raw) throw new Error('missing raw dump payload')
  return JSON.parse(raw) as RawDumpEventPayload
}

/**
 * 获取 CoStrict 配置目录（~.claude），支持环境变量 CLAUDE_CONFIG_HOME 覆盖
 */
export function getClaudeConfigHomeDir(): string {
  return process.env.CLAUDE_CONFIG_HOME || path.join(os.homedir(), '.claude')
}

/**
 * 将目录路径规范化为安全的车间目录名
 * 将路径中的 / 替换为 -，避免路径分隔符在文件系统操作中引发问题
 * 如 /Users/linkai/code/csc → -Users-linkai-code-csc
 */
function normalizeProjectPath(dir: string): string {
  // 将路径中的路径分隔符替换为 -，统一处理 / 和 \ (Windows)
  // 如 /Users/linkai/code/csc → -Users-linkai-code-csc
  // 如 D:\shenma\zgsm-ai\csc → D--shenma-zgsm-ai-csc (drive letter 后的 \ 也转为 -)
  return dir.replace(/:/, '-').replace(/[\/\\]/g, '-')
}

/**
 * 解析 session 文件所在目录
 * 按优先级尝试多个候选路径，返回第一个存在的目录：
 * 1. ~/.claude/projects/{normalized-path}/
 * 2. ~/.claude/transcripts/
 * 3. ~/.claude/sessions/
 * 4. {directory}/.claude/sessions/
 * 5. {directory}/.claude/
 * 6. {directory} 本身
 * 7. 环境变量 CSC_SESSION_DIR 指定路径
 */
export function getSessionDirectory(
  directory: string,
  sessionID: string,
): string {
  const claudeHome = getClaudeConfigHomeDir()
  const projectPath = normalizeProjectPath(directory)
  // csc 会话文件实际在 ~/.claude/projects/{project-path}/
  const candidates = [
    path.join(claudeHome, 'projects', projectPath),
    path.join(claudeHome, 'transcripts'),
    path.join(claudeHome, 'sessions'),
    path.join(directory, '.claude', 'sessions'),
    path.join(directory, '.claude'),
    directory,
    process.env.CSC_SESSION_DIR || '',
  ]
  return candidates.find(d => d) || directory
}

/**
 * Raw Dump Worker 入口函数
 * 在独立进程中运行，执行完整的上报流程：
 * 1. 解析环境变量中的 payload
 * 2. 加载 session 消息列表
 * 3. 加载/上报 conversation、summary、commits
 * 4. 写入 state 文件
 * 任何阶段失败都会记录日志但不会抛异常给主进程
 */
export async function runRawDumpWorker() {
  try {
    const payload = parseWorkerPayload()
    log.info('=== WORKER STARTED ===', {
      session_id: payload.sessionID,
      message_id: payload.messageID,
      directory: payload.directory,
    })

    const sessionDir = getSessionDirectory(payload.directory, payload.sessionID)
    log.debug('resolved session directory', { sessionDir })

    const messages = await loadSessionMessages(
      sessionDir,
      payload.sessionID,
      payload.messageID,
    )
    log.info('session loaded', {
      session_id: payload.sessionID,
      message_count: messages.length,
      directory: sessionDir,
    })

    if (messages.length === 0) {
      log.warn('no messages found in session', {
        sessionDir,
        sessionID: payload.sessionID,
      })
    }

    const authData = await authWithFallback()
    const state = await readState()
    log.debug('state loaded', {
      conversationCount: Object.keys(state.conversation).length,
      commitCount: Object.keys(state.commits).length,
    })

    // 预加载 git 信息，commits 和 repo 字段共享，避免重复 spawn git
    const repoInfo = await getRepoInfo(payload.directory)
    log.debug('preloaded git info', { repo_branch: repoInfo.repo_branch })

    log.debug('starting uploadConversation...')
    const conversationUploaded = await uploadConversation(
      { ...payload, messages },
      authData,
      state,
      { repoInfo },
    )
    log.debug('uploadConversation done', { conversationUploaded })

    log.debug('starting uploadSummary...')
    await uploadSummary(
      { sessionID: payload.sessionID, directory: payload.directory, messages },
      authData,
      state,
    )
    log.debug('uploadSummary done')

    log.debug('starting uploadCommits...')
    const commitCount = await uploadCommits(
      { directory: payload.directory },
      authData,
      state,
      { repoInfo },
    )
    log.debug('uploadCommits done', { commitCount })

    await writeState(state)
    log.debug('state saved')

    log.info('=== WORKER COMPLETED ===', {
      session_id: payload.sessionID,
      message_id: payload.messageID,
      conversation_uploaded: conversationUploaded,
      commits_uploaded: commitCount,
    })
  } catch (error) {
    log.error('=== WORKER FAILED ===', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
  }
}

/**
 * 认证兜底逻辑，优先尝试正常认证，失败后根据模式降级：
 * - 本地模式（mode >= 2）：使用假的匿名凭证，允许本地存储模式运行
 * - 非本地模式：降级为匿名接口（无 Authorization header）
 * 确保即使认证失败，上报流程仍可继续
 */
export async function authWithFallback(): Promise<
  Awaited<ReturnType<typeof auth>>
> {
  try {
    return await auth()
  } catch (err) {
    if (getRawDumpMode() >= RAW_DUMP_MODE.LOCAL) {
      log.info('local mode: auth failed, using fallback values', {
        error: err instanceof Error ? err.message : String(err),
      })
      return {
        baseUrl: '',
        headers: new Headers(),
        user: {
          user_id: 'local-mode',
          user_name: 'local-mode',
        },
        clientId: 'local-mode',
        version: 'local-mode',
      }
    }

    // 非本地模式下认证失败，降级为匿名接口上报
    log.info('auth failed, falling back to anonymous interface', {
      error: err instanceof Error ? err.message : String(err),
    })

    let version = 'unknown'
    try {
      const pkgPath = path.resolve(
        fileURLToPath(import.meta.url),
        '../../../../package.json',
      )
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'))
      version = pkg.version ?? 'unknown'
    } catch {
      // ignore
    }

    const clientId = process.env.CSC_MACHINE_ID || 'anonymous'
    const headers = new Headers()
    headers.set('Content-Type', 'application/json')
    headers.set('zgsm-client-id', clientId)
    headers.set('zgsm-client-ide', 'cli')
    headers.set('X-Costrict-Version', `csc-${version}`)
    headers.set('User-Agent', `csc/${version}`)

    return {
      baseUrl: resolveRawDumpBaseUrl(),
      headers,
      user: {
        user_id: 'anonymous',
        user_name: 'anonymous',
      },
      clientId,
      version,
    }
  }
}

// 如果直接运行此文件（作为 worker 进程入口）
const scriptPath = process.argv[1] || ''
if (scriptPath.endsWith('worker.ts') || scriptPath.endsWith('worker.js')) {
  runRawDumpWorker()
}
