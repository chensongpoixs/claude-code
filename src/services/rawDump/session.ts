/**
 * Raw Dump Session Utilities
 * 与 session 相关的工具函数，从 worker.ts 和 batchWorker.ts 中剥离
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLogger } from './logger.js'
import { countDiffLines, extractFilesFromDiff } from './git.js'

const log = createLogger('raw-dump-session')

/**
 * 获取 CoStrict 配置目录（~/.claude），支持环境变量 CLAUDE_CONFIG_HOME 覆盖
 */
export function getClaudeConfigHomeDir(): string {
  return process.env.CLAUDE_CONFIG_HOME || path.join(os.homedir(), '.claude')
}

/**
 * 将目录路径规范化为安全的车间目录名
 * 将路径中的 / 替换为 -，避免路径分隔符在文件系统操作中引发问题
 * 如 /Users/linkai/code/csc → -Users-linkai-code-csc
 */
export function normalizeProjectPath(dir: string): string {
  return dir.replace(/:/, '-').replace(/[/\\]/g, '-')
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
            m.session_id === sessionId
        )
        const hasMessage = messageId
          ? lines.some(
              m =>
                m.uuid === messageId,
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
export function findMessage(
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
export function findParentUserMessage(
  messages: Record<string, unknown>[],
  assistantMsg: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const assistantIndex = messages.indexOf(assistantMsg)
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
export function detectSender(
  assistant: Record<string, unknown>,
  user: Record<string, unknown> | undefined,
): string {
  const mode = String(assistant.mode ?? '')
  if (mode === 'agent' || mode === 'auto') return 'agent'
  if (assistant.agent) return 'agent'
  if (assistant.isSidechain === true) return 'agent'
  if (user?.isMeta === true) return 'agent'
  return 'user'
}

/**
 * 从消息对象中提取纯文本内容
 * 兼容多种格式：直接 content 字符串，或 content 数组（block type === 'text'）
 */
export function extractTextContent(msg: Record<string, unknown>): string {
  const content = (msg.message as Record<string, unknown>)?.content
  if (!Array.isArray(content)) return String(content ?? '')
  return content
    .filter((block): block is Record<string, unknown> => block?.type === 'text')
    .map(block => String(block.text ?? ''))
    .join('\n')
}

/**
 * 将 structured patch 格式转换为 unified diff 格式
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
 */
export function extractToolDiff(
  msg: Record<string, unknown>,
  allMessages?: Record<string, unknown>[],
): { diff: string; diff_lines: number; files: string[] } {
  const diffs: string[] = []
  const files = new Set<string>()
  const handledToolUseIds = new Set<string>()

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
 */
export function extractUsage(msg: Record<string, unknown>) {
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
 */
export function extractError(msg: Record<string, unknown>): {
  error_code?: number
  error_reason?: string
} {
  const error = msg.error

  if (typeof error === 'string') {
    const errorCode = SDK_ERROR_CODE_MAP[error] ?? 500
    const errorDetails = msg.errorDetails
    const reason =
      typeof errorDetails === 'string' && errorDetails ? errorDetails : error
    return { error_code: errorCode, error_reason: reason }
  }

  if (typeof error === 'object' && error !== null) {
    const err = error as Record<string, unknown>
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

  if (msg.isApiErrorMessage) {
    return { error_code: 500, error_reason: 'api_error_unclassified' }
  }

  return {}
}

/**
 * 从 sessionDir 目录中获取最新的 sessionId 和 messageId
 * 扫描所有 .jsonl 文件，按 timestamp 降序排列，返回最新一条消息的 sessionId 和 messageId
 */
export async function getLatestSessionInfo(
  sessionDir: string,
): Promise<{ sessionId: string; messageId: string } | null> {
  try {
    const entries = await fs.readdir(sessionDir)
    const jsonlFiles = entries.filter(f => f.endsWith('.jsonl'))
    if (jsonlFiles.length === 0) return null

    let latestMsg: { sessionId: string; messageId: string; ts: number } | null = null

    for (const file of jsonlFiles) {
      const filePath = path.join(sessionDir, file)
      try {
        const text = await fs.readFile(filePath, 'utf-8')
        const lines = text.split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const msg = JSON.parse(line) as Record<string, unknown>
            const ts = (msg.timestamp as number) || 0
            if (!latestMsg || ts > latestMsg.ts) {
              const sessionId =
                (msg.sessionId as string) ||
                (msg.session_id as string) ||
                (msg.uuid as string) ||
                ''
              const messageId =
                (msg.uuid as string) ||
                ((msg.message as Record<string, unknown>)?.id as string) ||
                ''
              if (sessionId && messageId) {
                latestMsg = { sessionId, messageId, ts }
              }
            }
          } catch {
            // ignore parse errors
          }
        }
      } catch {
        // ignore file read errors
      }
    }

    if (latestMsg) {
      log.debug('found latest session info', {
        sessionId: latestMsg.sessionId,
        messageId: latestMsg.messageId,
        ts: latestMsg.ts,
      })
      return { sessionId: latestMsg.sessionId, messageId: latestMsg.messageId }
    }
  } catch {
    // ignore dir read errors
  }
  return null
}

// Session messages 缓存（batchWorker 使用）
// 缓存结构: [sessionJsonlFileName, file-timestamp, cache-timestamp, messages]
type SessionMessagesCacheEntry = [
  sessionJsonlFileName: string,
  fileTimestamp: number,
  cacheTimestamp: number,
  messages: Record<string, unknown>[],
]
const sessionMessagesCache = new Map<string, SessionMessagesCacheEntry>()

/**
 * 获取缓存的 session messages
 * 缓存 key: sessionDir:sessionId
 * 缓存值: [sessionJsonlFileName, file-timestamp, cache-timestamp, messages]
 * 当文件相比缓存时有更新（只要变化就认为有更新），则重新加载
 */
export async function getCachedSessionMessages(
  sessionDir: string,
  sessionID: string,
  messageID?: string,
) {
  const cacheKey = `${sessionDir}:${sessionID}`
  const cached = sessionMessagesCache.get(cacheKey)

  // 尝试找到当前 session 文件
  const findCurrentFile = async (): Promise<{ fileName: string; filePath: string } | null> => {
    try {
      const entries = await fs.readdir(sessionDir)
      const jsonlFiles = entries.filter(f => f.endsWith('.jsonl'))
      const prioritized = jsonlFiles.sort((a, b) => {
        const aHas = a.includes(sessionID)
        const bHas = b.includes(sessionID)
        if (aHas && !bHas) return -1
        if (!aHas && bHas) return 1
        return 0
      })
      for (const file of prioritized) {
        const filePath = path.join(sessionDir, file)
        const text = await fs.readFile(filePath, 'utf-8')
        const lines = text.split('\n').filter(Boolean)
        const hasSession = lines.some(m => {
          const msg = JSON.parse(m) as Record<string, unknown>
          return msg.sessionId === sessionID || msg.session_id === sessionID || msg.uuid === sessionID
        })
        if (hasSession) {
          return { fileName: file, filePath }
        }
      }
    } catch {}
    return null
  }

  if (cached) {
    const [cachedFileName, cachedFileTs] = cached
    const currentFile = await findCurrentFile()

    if (currentFile && currentFile.fileName === cachedFileName) {
      // 文件名匹配，检查文件是否更新
      try {
        const stats = await fs.stat(path.join(sessionDir, cachedFileName))
        const currentFileTs = stats.mtimeMs
        if (currentFileTs === cachedFileTs) {
          // 文件未变化，直接使用缓存
          log.debug('using cached session messages', { sessionID, cachedFileName })
          return cached[3]
        }
      } catch {}
    }

    // 文件有更新或文件名不匹配，需要重新加载
    log.debug('file changed, reloading session messages', { sessionID })
  }

  // 未找到缓存或文件已更新，搜索 session 文件
  const currentFile = await findCurrentFile()

  if (currentFile) {
    const start = Date.now()
    const messages = await loadSessionMessages(sessionDir, sessionID, messageID)
    const elapsed = Date.now() - start
    if (elapsed > 100) {
      log.info('loadSessionMessages slow', { sessionID, elapsedMs: elapsed })
    }
    try {
      const stats = await fs.stat(path.join(sessionDir, currentFile.fileName))
      sessionMessagesCache.set(cacheKey, [
        currentFile.fileName,
        stats.mtimeMs,
        Date.now(),
        messages,
      ])
    } catch {}
    return messages
  }

  // 文件不存在，缓存空结果
  sessionMessagesCache.set(cacheKey, ['', 0, Date.now(), []])
  return []
}
