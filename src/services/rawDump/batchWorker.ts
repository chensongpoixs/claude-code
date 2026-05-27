/**
 * Raw Dump Batch Worker
 * 顺序消费队列，避免并发 429
 * 独立进程，通过自循环 setTimeout 严格串行执行
 *
 * 单队列设计：
 * - 队列常驻内存，进程启动时一次性加载
 * - 入队/移除时写文件，其他操作仅更新内存
 * - 任务成功或 attemptCount >= MAX_ATTEMPTS 时从队列移除
 * - 任务失败但未超限：attemptCount++ 写回文件，下次 batch 重试
 *
 * 每轮 batch 三道防线：进程内重入保护 → 跨进程文件锁 → 消费后清空文件
 */

import {
  uploadConversation,
  uploadSummary,
  uploadCommits,
  uploadStatistics,
  authWithFallback,
} from './worker.js'
import {
  loadQueue,
  acquireLock,
  releaseLock,
  peekTask,
  removeTask,
  getQueue,
  flushQueue,
  MAX_ATTEMPTS,
  type QueueTask,
} from './queue.js'
import { readState, writeState, appendDeadLetter } from './state.js'
import { getSessionDirectory, loadSessionMessages } from './worker.js'
import { getRepoInfo } from './git.js'
import { createLogger } from './logger.js'

const log = createLogger('raw-dump-batch')

/**
 * 从错误信息中提取 API endpoint 路径
 * 错误格式："/raw-store/task-conversation failed: 401 ..."
 */
function extractEndpointFromError(errorMsg: string): string | undefined {
  const match = errorMsg.match(/\/(raw-store\/[^\s]+)/)
  return match?.[1]
}

type RepoInfo = Awaited<ReturnType<typeof getRepoInfo>>

const BATCH_INTERVAL_MS = 120_000

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

let isRunning = false

const PARENT_PID = process.ppid
const IS_WORKER_PROCESS = process.argv[1]?.includes('batchWorker') || false

function isParentAlive(): boolean {
  if (!IS_WORKER_PROCESS) return true
  try {
    process.kill(PARENT_PID, 0)
    return true
  } catch {
    return false
  }
}

// Session messages 缓存
const sessionMessagesCache = new Map<
  string,
  { messages: Record<string, unknown>[]; ts: number }
>()
const SESSION_CACHE_TTL_MS = 60_000

async function getCachedSessionMessages(
  sessionDir: string,
  sessionID: string,
  messageID?: string,
) {
  const cacheKey = `${sessionDir}:${sessionID}`
  const cached = sessionMessagesCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < SESSION_CACHE_TTL_MS) {
    return cached.messages
  }
  const start = Date.now()
  const messages = await loadSessionMessages(sessionDir, sessionID, messageID)
  const elapsed = Date.now() - start
  if (elapsed > 100) {
    log.info('loadSessionMessages slow', { sessionID, elapsedMs: elapsed })
  }
  sessionMessagesCache.set(cacheKey, { messages, ts: Date.now() })
  return messages
}

/**
 * 处理单个上报任务
 * 成功完成后由调用方从队列中移除
 */
async function processTask(
  task: QueueTask,
  state: Awaited<ReturnType<typeof readState>>,
) {
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

  if (task.messageID === '__statistics__' && task.statsData) {
    await uploadStatistics(
      {
        sessionID: task.sessionID,
        directory: task.directory,
        sessionCount: task.statsData.sessionCount,
        conversationCount: task.statsData.conversationCount,
        upstreamTokens: task.statsData.upstreamTokens,
        downstreamTokens: task.statsData.downstreamTokens,
        startTime: task.statsData.startTime,
        endTime: task.statsData.endTime,
      },
      authData,
      state,
    )
    log.info('statistics task completed', { sessionID: task.sessionID })
    return
  }

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

  await uploadSummary(
    { sessionID: task.sessionID, directory: task.directory, messages },
    authData,
    state,
  )

  await uploadCommits({ directory: task.directory }, authData, state, {
    repoInfo,
  })

  log.info('task completed', {
    sessionID: task.sessionID,
    conversationUploaded,
  })
}

/**
 * 执行一轮 batch 处理
 * 流程：获取锁 → 读队列内存 → 去重 → 逐个处理 → 写 state
 */
async function runBatch() {
  if (isRunning) {
    log.debug('runBatch already running in-process, skip')
    return
  }
  isRunning = true

  try {
    if (!(await acquireLock())) {
      log.debug('another worker process holds the lock, skip')
      return
    }

    try {
      const state = await readState()
      const tasks = getQueue()

      if (tasks.length === 0) {
        log.debug('queue empty')
        return
      }

      log.info(`processing ${tasks.length} tasks`)

      // 去重：同一 session:messageID 只保留最新的
      const deduped = new Map<string, QueueTask>()
      for (const task of tasks) {
        const key = `${task.sessionID}:${task.messageID}`
        const existing = deduped.get(key)
        if (!existing || task.enqueuedAt > existing.enqueuedAt) {
          deduped.set(key, task)
        }
      }

      const uniqueTasks = Array.from(deduped.values()).sort(
        (a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt),
      )

      log.info(`deduped to ${uniqueTasks.length} unique tasks`)

      for (const task of uniqueTasks) {
        const key = `${task.sessionID}:${task.messageID}`
        try {
          await processTask(task, state)
          removeTask(key)
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          task.attemptCount++
          log.error('task failed', {
            error: errorMsg,
            sessionID: task.sessionID,
            attemptCount: task.attemptCount,
          })

          if (task.attemptCount >= MAX_ATTEMPTS) {
            // 彻底失败：写入 dead letter，从队列移除
            await appendDeadLetter({
              sessionID: task.sessionID,
              messageID: task.messageID,
              directory: task.directory,
              attemptCount: task.attemptCount,
              error: errorMsg,
              endpoint: extractEndpointFromError(errorMsg),
              failedAt: new Date().toISOString(),
            })
            removeTask(key)
            log.warn('task permanently failed, removed from queue', {
              sessionID: task.sessionID,
              attemptCount: task.attemptCount,
            })
          } else {
            // 失败但未超限：attemptCount++ 写回文件，下次重试
            await flushQueue()
          }
        }
      }

      await writeState(state)
      log.info('batch completed')
    } finally {
      await releaseLock()
    }
  } finally {
    isRunning = false
  }
}

/**
 * 启动 Batch Worker
 * 进程启动时加载队列到内存，此后队列常驻内存运行
 */
export function startBatchWorker() {
  log.info('batch worker started', { interval: BATCH_INTERVAL_MS })

  const scheduleNext = (delay: number) => {
    setTimeout(async () => {
      if (!isParentAlive()) {
        log.info('parent process exited, stopping batch worker')
        process.exit(0)
      }
      try {
        await runBatch()
      } catch (err) {
        log.error('runBatch threw', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      const jitter = Math.floor(Math.random() * 5_000)
      scheduleNext(BATCH_INTERVAL_MS + jitter)
    }, delay)
  }

  // 启动时加载队列 + 随机抖动
  loadQueue()
    .then(() => {
      log.info('queue loaded', { count: getQueue().length })
      scheduleNext(Math.floor(Math.random() * 10_000))
    })
    .catch(err => {
      log.error('failed to load queue', {
        error: err instanceof Error ? err.message : String(err),
      })
      process.exit(1)
    })
}

const scriptPath = process.argv[1] || ''
if (
  scriptPath.endsWith('batchWorker.ts') ||
  scriptPath.endsWith('batchWorker.js')
) {
  startBatchWorker()
}
