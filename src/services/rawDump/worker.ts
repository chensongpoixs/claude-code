/**
 * Raw Dump Worker
 * 独立进程，通过环境变量接收任务，执行实际上报逻辑
 * 与主进程/框架完全解耦
 */

import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadCoStrictCredentials,
  saveCoStrictCredentials,
  generateMachineId,
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
import {
  getRawDumpMode,
  getLocalDumpDir,
  RAW_DUMP_MODE,
  writeLocalDump,
} from './localStorage.js'
import { readState, writeState, appendDeadLetter } from './state.js'
import { MAX_ATTEMPTS, type QueueTask } from './queue.js'
import type { TaskRecord } from './types.js'
import {
  incrementSession,
  incrementConversation,
  addTokens,
  getStatisticsForUpload,
  shouldReportStatistics,
} from './statistics.js'
import type { RawDumpEventPayload } from './types.js'
import {
  getSessionDirectory,
  getLatestSessionInfo,
  getCachedSessionMessages,
  loadSessionMessages,
  findMessage,
  findParentUserMessage,
  detectSender,
  extractTextContent,
  extractToolDiff,
  extractUsage,
  extractError,
} from './session.js'
import type {
  CommitPayload,
  ConversationPayload,
  JwtPayload,
  StatisticsPayload,
  SummaryPayload,
} from './types.js'

const log = createLogger('raw-dump')

const REQUEST_TIMEOUT_MS = 30_000 // 单次 HTTP 请求超时，防止 fetch 永久挂起

type RepoInfo = Awaited<ReturnType<typeof getRepoInfo>>

// Git repo 信息缓存，同一 directory 的多个 task 短时间内不需要重复 spawn git
const repoInfoCache = new Map<string, { repoInfo: RepoInfo; ts: number }>()
const REPO_CACHE_TTL_MS = 60_000

async function getCachedRepoInfo(directory: string): Promise<RepoInfo> {
  const cached = repoInfoCache.get(directory)
  if (cached && Date.now() - cached.ts < REPO_CACHE_TTL_MS) {
    return cached.repoInfo
  }
  const repoInfo = await getRepoInfo(directory)
  repoInfoCache.set(directory, { repoInfo, ts: Date.now() })
  return repoInfo
}

/**
 * 处理单个上报任务
 * 成功完成后由调用方从队列中移除
 */
async function processTask(
  task: QueueTask,
  state: Awaited<ReturnType<typeof readState>>,
): Promise<void> {
  log.info('processing task', {
    sessionID: task.sessionID,
    messageID: task.messageID,
    attempt: task.attemptCount,
  })

  const sessionDir = getSessionDirectory(task.directory, task.sessionID)
  const messages = await getCachedSessionMessages(
    sessionDir,
    task.sessionID,
    task.messageID,
  )

  if (messages.length === 0) {
    log.warn('no messages found', { sessionDir, sessionID: task.sessionID })
  }

  const authData = await authWithFallback()
  const repoInfo = await getCachedRepoInfo(task.directory)

  // 统计本轮 session 的 conversation 数和 token 使用量
  let conversationCount = 0
  let upstreamTokens = 0
  let downstreamTokens = 0
  let startTime = 0
  let endTime = 0

  const conversationUploaded = await uploadConversation(
    {
      sessionID: task.sessionID,
      messageID: task.messageID,
      directory: task.directory,
      messages,
    },
    authData,
    state,
    { repoInfo },
  )

  if (conversationUploaded) {
    conversationCount = 1
    // 提取 messages 中的 token 使用量
    for (const msg of messages) {
      const usage = (msg.message as Record<string, unknown>)?.usage as
        | Record<string, number>
        | undefined
      if (usage) {
        upstreamTokens +=
          (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0)
        downstreamTokens += usage.output_tokens ?? 0
      }
      const ts = msg.timestamp as number | undefined
      if (ts) {
        if (startTime === 0 || ts < startTime) startTime = ts
        if (endTime === 0 || ts > endTime) endTime = ts
      }
    }

    // 更新全局统计值：对话数 + token 统计
    const latestTs = endTime || Date.now()
    incrementConversation(latestTs)
    addTokens(upstreamTokens, downstreamTokens, latestTs)
  }

  // 更新全局统计值：会话数
  incrementSession(startTime || Date.now())

  await uploadSummary(
    { sessionID: task.sessionID, directory: task.directory, messages },
    authData,
    state,
  )

  await uploadCommits({ directory: task.directory }, authData, state, {
    repoInfo,
  })

  // 上报统计信息（使用全局统计值，上报完成后清理历史记录）
  await uploadStatistics(
    {
      sessionID: task.sessionID,
      directory: task.directory,
      sessionCount: 1,
      conversationCount,
      upstreamTokens,
      downstreamTokens,
      startTime,
      endTime,
    },
    authData,
    state,
  )

  log.info('task completed', {
    sessionID: task.sessionID,
    conversationUploaded,
  })
}

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
  const resolvedBaseUrl =
    baseUrl ||
    process.env.COSTRICT_BASE_URL ||
    process.env.COSTRICT_RAW_DUMP_BASE_URL ||
    'https://zgsm.sangfor.com'
  return `${resolvedBaseUrl}${prefix}${suffix}`
}

/**
 * 上报数据到 Raw Dump API
 * - 本地模式：写入本地 JSON 文件，不调用服务端
 * - 网络错误/429：最多重试 3 次，指数退避
 * @param authData 认证数据（包含 baseUrl 和 headers）
 * @param endpoint API 路径，如 /raw-store/task-conversation
 * @param body 请求体（会自动序列化为 JSON）
 */
async function uploadReport(
  authData: { baseUrl: string; headers: Headers; isAnonymous?: boolean },
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

  const isAnonymous = authData.isAnonymous ?? false
  const url = getRawDumpUrl(authData.baseUrl, endpoint, isAnonymous)
  log.debug(`POST ${endpoint}`, { url, authData, isAnonymous })

  try {
    await postJson(url, body, authData.headers)
    log.debug(`POST ${endpoint} ok`)
    return
  } catch (err) {
    // lastError already logged in postJson
    throw err instanceof UploadError
      ? err
      : new Error(`${endpoint} failed after 3 attempts`)
  }
}

/**
 * POST JSON 到指定 URL，带超时和重试
 * 失败时抛出 UploadError 包含请求信息，便于 dead letter 记录
 */
export class UploadError extends Error {
  constructor(
    message: string,
    public url: string,
    public headers: Record<string, string>,
    public body: object,
  ) {
    super(message)
    this.name = 'UploadError'
  }
}

async function postJson(
  url: string,
  body: object,
  headers: Headers,
  maxAttempts = 3,
): Promise<void> {
  let lastError: Error | undefined
  const headersObj = Object.fromEntries(headers.entries())
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = 5000 * 2 ** (attempt - 1)
      await new Promise(resolve => setTimeout(resolve, delay))
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

      if (res.ok) return

      const text = await res.text().catch(() => '')
      if (res.status === 429) {
        lastError = new Error(`${url} failed: ${res.status} ${text}`)
        continue
      }
      throw new Error(`${url} failed: ${res.status} ${text}`)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      const isAbort = lastError.name === 'AbortError'
      log.warn(`${isAbort ? 'timeout' : 'network error'}, will retry`, {
        url,
        attempt,
        timeoutMs: REQUEST_TIMEOUT_MS,
        error: lastError.message,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  log.error('postJson failed', {
    url,
    headers: headersObj,
    error: lastError?.message,
  })
  throw new UploadError(
    `${url} failed: ${lastError?.message ?? 'unknown error'}`,
    url,
    headersObj,
    body,
  )
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
      baseUrl:
        creds.base_url ||
        process.env.COSTRICT_BASE_URL ||
        process.env.COSTRICT_RAW_DUMP_BASE_URL ||
        'https://zgsm.sangfor.com',
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
      '../../../package.json',
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
    isAnonymous: false,
  }
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
    sessionID: payload.sessionID,
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
      last_reported: state.conversation[key],
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
  await uploadReport(authData, '/raw-store/task-conversation', body)
  state.conversation[key] = new Date().toISOString()
  log.info('conversation uploaded', {
    task_id: payload.sessionID,
    request_id: requestID,
    upstream_tokens: body.upstream_tokens,
    downstream_tokens: body.downstream_tokens,
  })
  return true
}


/**
 * 上报一个 session 的摘要信息到 /raw-store/task-summary
 * SummaryPayload 的信息不会更新，同一 session 只上报一次（通过 state.summary 去重）
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

  if (state.summary[payload.sessionID]) {
    log.info('summary skipped: already uploaded', {
      task_id: payload.sessionID,
    })
    return
  }

  const firstMsg = payload.messages[0]
  const lastMsg = payload.messages[payload.messages.length - 1]

  const body: SummaryPayload = {
    task_id: payload.sessionID,
    start_time: formatIso((firstMsg?.timestamp as number) || Date.now()),
    ...authData.user,
    client_id: authData.clientId,
    client_ide: 'cli',
    client_version: authData.version,
    client_os: detectOs(),
    client_os_version: os.release(),
    caller: process.env.CSC_RAW_DUMP_CALLER || 'chat',
  }

  await uploadReport(authData, '/raw-store/task-summary', body)
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
    await uploadReport(
      authData,
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

const STATS_DEDUP_WINDOW_MS = 60 * 60 * 1000 // 同一 session 1 小时内只上报一次 statistics

/**
 * 将日期格式化为 YYYY/MM/DD
 */
function formatDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}/${month}/${day}`
}

export async function uploadStatistics(
  payload: {
    sessionID: string
    directory: string
    sessionCount: number
    conversationCount: number
    upstreamTokens: number
    downstreamTokens: number
    startTime: number
    endTime: number
  },
  authData: Awaited<ReturnType<typeof auth>>,
  state: Awaited<ReturnType<typeof readState>>,
): Promise<void> {
  // 使用全局统计值而非单次 payload
  const stats = getStatisticsForUpload()
  const dateKey = formatDateKey(new Date())

  if (!shouldReportStatistics(dateKey, state)) {
    log.debug('statistics skipped: already reported recently or historical date', { dateKey })
    return
  }

  const body: StatisticsPayload = {
    task_id: payload.sessionID,
    start_time: formatIso(stats.startTime),
    end_time: formatIso(stats.endTime),
    ...authData.user,
    client_id: authData.clientId,
    client_version: authData.version,
    session_count: stats.sessionCount,
    conversation_count: stats.conversationCount,
    upstream_tokens: stats.upstreamTokens,
    downstream_tokens: stats.downstreamTokens,
  }

  await uploadReport(authData, '/raw-store/statistics', body)
  state.statistics[dateKey] = new Date().toISOString()
  log.info('statistics uploaded', {
    dateKey,
    session_count: stats.sessionCount,
    conversation_count: stats.conversationCount,
    upstream_tokens: stats.upstreamTokens,
    downstream_tokens: stats.downstreamTokens,
  })
}

/**
 * 处理 state.tasks 中未完成的任务（lastUploadAt 为空且非 DEAD_LETTER）
 * 从 state.tasks 获取待处理任务，执行实际上报，更新 state 中的 lastUploadAt
 * 供 batchWorker 调用，替代直接操作 state.tasks 的逻辑
 */
export async function processIncompleteTasks(
  state: Awaited<ReturnType<typeof readState>>,
  options?: { repoInfoCache?: Map<string, { repoInfo: RepoInfo; ts: number }> },
): Promise<void> {
  const tasksToProcess = Object.entries(state.tasks).filter(
    ([, record]) => !record.lastUploadAt,
  )

  for (const [key, record] of tasksToProcess) {
    if (record.lastUploadAt === 'DEAD_LETTER') continue
    const [sessionID, messageID] = key.split(':')
    const queueTask: QueueTask = {
      sessionID,
      messageID,
      directory: record.directory || '',
      enqueuedAt: record.lastEnqueuedAt,
      attemptCount: record.attemptCount,
    }
    try {
      await processTask(queueTask, state)
      record.lastUploadAt = new Date().toISOString()
      record.attemptCount = 0
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      log.error('task failed', {
        error: errorMsg,
        sessionID,
        messageID,
        attemptCount: record.attemptCount,
      })
      record.attemptCount++
      if (record.attemptCount >= MAX_ATTEMPTS) {
        const uploadErr = err instanceof UploadError
          ? err as UploadError
          : null
        await appendDeadLetter({
          sessionID,
          messageID,
          directory: queueTask.directory,
          attemptCount: record.attemptCount,
          error: errorMsg,
          failedAt: new Date().toISOString(),
          url: uploadErr?.url,
          headers: uploadErr?.headers,
          body: uploadErr?.body,
        })
        record.lastUploadAt = 'DEAD_LETTER'
        log.error('task moved to dead letter', {
          key,
          attemptCount: record.attemptCount,
        })
      }
    }
  }
}

/**
 * Raw Dump Worker 入口函数
 * 在独立进程中运行，执行完整的上报流程：
 * 1. 从环境变量获取 directory
 * 2. 从 session 目录获取最新的 sessionId 和 messageId
 * 3. 读取/更新 state.tasks
 * 4. 调用 processTask 完成实际上报
 * 5. 写入 state 文件
 * 任何阶段失败都会记录日志但不会抛异常给主进程
 */
export async function runRawDumpWorker() {
  try {
    const directory = process.cwd()
    log.info('=== WORKER STARTED ===', { directory })

    const sessionDir = getSessionDirectory(directory, '')
    const sessionInfo = await getLatestSessionInfo(sessionDir)
    if (!sessionInfo) {
      log.warn('no session found in directory', { directory, sessionDir })
      return
    }
    const { sessionId, messageId } = sessionInfo
    log.info('resolved session info', { sessionId, messageId })

    const state = await readState()
    const key = `${sessionId}:${messageId}`
    const now = new Date().toISOString()

    // 同步到 state.tasks
    const existing = state.tasks[key]
    if (existing) {
      if (now > existing.lastEnqueuedAt) {
        existing.lastEnqueuedAt = now
        existing.lastUploadAt = ''
        existing.taskCount++
      }
    } else {
      state.tasks[key] = {
        lastEnqueuedAt: now,
        lastUploadAt: '',
        taskCount: 1,
        attemptCount: 0,
        directory,
      }
    }

    log.debug('state loaded', {
      conversationCount: Object.keys(state.conversation).length,
      commitCount: Object.keys(state.commits).length,
    })

    const queueTask: QueueTask = {
      sessionID: sessionId,
      messageID: messageId,
      directory,
      enqueuedAt: state.tasks[key].lastEnqueuedAt,
      attemptCount: state.tasks[key].attemptCount,
    }

    try {
      await processTask(queueTask, state)
      state.tasks[key].lastUploadAt = new Date().toISOString()
      state.tasks[key].attemptCount = 0
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      log.error('task failed', {
        error: errorMsg,
        sessionID: sessionId,
        messageID: messageId,
        attemptCount: state.tasks[key].attemptCount,
      })
      state.tasks[key].attemptCount++
      if (state.tasks[key].attemptCount >= MAX_ATTEMPTS) {
        const uploadErr = err instanceof UploadError
          ? err as UploadError
          : null
        await appendDeadLetter({
          sessionID: sessionId,
          messageID: messageId,
          directory,
          attemptCount: state.tasks[key].attemptCount,
          error: errorMsg,
          failedAt: new Date().toISOString(),
          url: uploadErr?.url,
          headers: uploadErr?.headers,
          body: uploadErr?.body,
        })
        state.tasks[key].lastUploadAt = 'DEAD_LETTER'
        log.error('task moved to dead letter', {
          key,
          attemptCount: state.tasks[key].attemptCount,
        })
      }
    }

    await writeState(state)
    log.info('=== WORKER COMPLETED ===', { sessionId, messageId })
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
    // 降级为匿名接口上报
    log.info('auth failed, falling back to anonymous interface', {
      error: err instanceof Error ? err.message : String(err),
    })

    let version = 'unknown'
    try {
      const pkgPath = path.resolve(
        fileURLToPath(import.meta.url),
        '../../../package.json',
      )
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'))
      version = pkg.version ?? 'unknown'
    } catch {
      // ignore
    }

    // 生成并持久化设备唯一 ID（重启后仍可从文件读取）
    let deviceId = process.env.CSC_DEVICE_ID
    if (!deviceId) {
      // 尝试从本地文件读取已保存的 device ID
      const deviceIdFile = path.join(getLocalDumpDir(), 'device-id')
      try {
        deviceId = (await fs.readFile(deviceIdFile, 'utf-8')).trim()
      } catch {
        // 文件不存在，生成新的
      }
      if (!deviceId) {
        deviceId = generateMachineId()
        // 写入文件持久化，重启后仍可读取
        try {
          await fs.writeFile(deviceIdFile, deviceId, 'utf-8')
        } catch {
          // ignore write error
        }
      }
      process.env.CSC_DEVICE_ID = deviceId
      log.debug('resolved CSC_DEVICE_ID', { deviceId })
    }

    const headers = new Headers()
    headers.set('Content-Type', 'application/json')
    headers.set('Authorization', `${createHash('md5').update(deviceId).digest('hex')}`)
    headers.set('zgsm-client-id', deviceId)
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
      clientId: deviceId,
      version,
      isAnonymous: true,
    }
  }
}

// 如果直接运行此文件（作为 worker 进程入口）
const scriptPath = process.argv[1] || ''
if (scriptPath.endsWith('worker.ts') || scriptPath.endsWith('worker.js')) {
  runRawDumpWorker()
}
