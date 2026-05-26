/**
 * Raw Dump Batch Worker
 * 顺序消费队列，避免并发 429
 * 独立进程，通过自循环 setTimeout 严格串行执行
 */

import {
  uploadConversation,
  uploadSummary,
  uploadCommits,
  authWithFallback,
} from './worker.js'
import {
  readQueue,
  clearQueue,
  acquireLock,
  releaseLock,
  type QueueTask,
} from './queue.js'
import { readState, writeState } from './state.js'
import { getSessionDirectory, loadSessionMessages } from './worker.js'
import { getRepoInfo } from './git.js'
import { createLogger } from './logger.js'

const log = createLogger('raw-dump-batch')

type RepoInfo = Awaited<ReturnType<typeof getRepoInfo>>

const BATCH_INTERVAL_MS = 120_000 // 每轮间隔（2 分钟），降低内联运行时的 CPU 影响

// Git repo 信息缓存，同一 directory 的多个 task 短时间内不需要重复 spawn git
const repoInfoCache = new Map<string, { repoInfo: RepoInfo; ts: number }>()
const REPO_CACHE_TTL_MS = 60_000

/**
 * 批量获取 Git 仓库信息（带缓存）
 * 同一 directory 在 60 秒内不重复调用 git 命令
 * @returns 缓存的 RepoInfo 或新获取的信息
 */
async function getCachedRepoInfo(directory: string): Promise<RepoInfo> {
  const cached = repoInfoCache.get(directory)
  if (cached && Date.now() - cached.ts < REPO_CACHE_TTL_MS) {
    log.debug('repo info cache hit', { directory })
    return cached.repoInfo
  }
  const repoInfo = await getRepoInfo(directory)
  repoInfoCache.set(directory, { repoInfo, ts: Date.now() })
  return repoInfo
}
// 进程内重入保护：文件锁不防同进程重入，必须用内存 flag 兜底
let isRunning = false

const PARENT_PID = process.ppid
const IS_WORKER_PROCESS = process.argv[1]?.includes('batchWorker') || false

/**
 * 检测父进程是否还在运行
 * - 仅在独立 worker 进程中生效（IS_WORKER_PROCESS = true）
 * - 使用 kill(pid, 0) 检测进程是否存在
 * - 父进程退出时 worker 应停止，避免孤儿进程
 */
function isParentAlive(): boolean {
  if (!IS_WORKER_PROCESS) return true
  try {
    process.kill(PARENT_PID, 0)
    return true
  } catch {
    return false
  }
}

// Session messages 缓存：同一 session 的多个 task 短时间内不需要重复读取 JSONL
const sessionMessagesCache = new Map<
  string,
  { messages: Record<string, unknown>[]; ts: number }
>()
const SESSION_CACHE_TTL_MS = 60_000

/**
 * 批量获取 session 消息列表（带缓存）
 * 同一 sessionDir + sessionID 在 60 秒内不重复读取 JSONL 文件
 * 记录加载耗时，超过 100ms 时输出 info 日志（便于发现性能问题）
 */
async function getCachedSessionMessages(
  sessionDir: string,
  sessionID: string,
  messageID?: string,
) {
  const cacheKey = `${sessionDir}:${sessionID}`
  const cached = sessionMessagesCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < SESSION_CACHE_TTL_MS) {
    log.debug('session messages cache hit', { sessionID, messageID })
    return cached.messages
  }
  const start = Date.now()
  const messages = await loadSessionMessages(sessionDir, sessionID, messageID)
  const elapsed = Date.now() - start
  if (elapsed > 100) {
    log.info('loadSessionMessages slow', {
      sessionID,
      elapsedMs: elapsed,
      messageCount: messages.length,
    })
  }
  sessionMessagesCache.set(cacheKey, { messages, ts: Date.now() })
  return messages
}

/**
 * 处理单个上报任务
 * - 加载 session 消息（可能为空）
 * - 依次调用 uploadConversation、uploadSummary、uploadCommits
 * - 任何任务失败都抛异常，由上层 runBatch 统一处理
 * @param task 队列任务
 * @param state 当前 batch 的 state 快照（内存引用，函数内修改会直接反映到外层）
 */
async function processTask(
  task: QueueTask,
  state: Awaited<ReturnType<typeof readState>>,
) {
  log.info('processing task', {
    sessionID: task.sessionID,
    messageID: task.messageID,
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

  // 预加载 git 信息，commits 和 repo 字段共享，避免每个 task 重复 spawn git 进程
  const repoInfo = await getCachedRepoInfo(task.directory)

  try {
    // conversation
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

    // summary（5 分钟内同一 session 只上报一次）
    await uploadSummary(
      { sessionID: task.sessionID, directory: task.directory, messages },
      authData,
      state,
    )

    // commits（限制频率，避免重复上报）
    await uploadCommits({ directory: task.directory }, authData, state, {
      repoInfo,
    })

    log.info('task completed', {
      sessionID: task.sessionID,
      conversationUploaded,
    })
  } catch (err) {
    log.error('task failed', {
      error: err instanceof Error ? err.message : String(err),
      sessionID: task.sessionID,
    })
    throw err
  }
}

/**
 * 执行一轮 batch 处理
 * 三道防线：进程内重入保护 → 跨进程文件锁 → 读取后立即清空队列
 * 流程：读取队列 → 清空队列 → 去重 → 逐个处理任务 → 一次性写入 state
 */
async function runBatch() {
  // 第一道防线：同进程重入保护
  if (isRunning) {
    log.debug('runBatch already running in-process, skip')
    return
  }
  isRunning = true

  try {
    // 第二道防线：跨进程文件锁
    if (!(await acquireLock())) {
      log.debug('another worker process holds the lock, skip')
      return
    }

    try {
      const tasks = await readQueue()
      if (tasks.length === 0) {
        log.debug('queue empty')
        return
      }

      // 第三道防线：读完立刻清空队列
      // - 处理期间新进来的任务会在下一轮处理
      // - 即使有意外的并发 runBatch 拿到锁，也只会看到空队列直接返回
      await clearQueue()

      log.info(`processing ${tasks.length} tasks`)

      // 去重：同一个 session 的多个 task，只保留最新的一个
      const deduped = new Map<string, QueueTask>()
      for (const task of tasks) {
        const key = `${task.sessionID}:${task.messageID}`
        const existing = deduped.get(key)
        if (!existing || task.enqueuedAt > existing.enqueuedAt) {
          deduped.set(key, task)
        }
      }

      const uniqueTasks = Array.from(deduped.values()).sort(
        (a, b) => a.enqueuedAt - b.enqueuedAt,
      )
      log.info(`deduped to ${uniqueTasks.length} unique tasks`)

      // 一次性读取 state，所有 task 共享，减少文件锁竞争和重复 JSON 解析
      const state = await readState()

      for (const task of uniqueTasks) {
        try {
          await processTask(task, state)
        } catch (err) {
          log.error('task failed', {
            error: err instanceof Error ? err.message : String(err),
            sessionID: task.sessionID,
          })
        }
      }

      // 所有 task 处理完后一次性写入 state
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
 * 通过 setTimeout 自循环实现严格串行执行，避免并发触发 API 限流
 * 启动时随机抖动 0~10 秒，避免多个 csc 实例同时启动时撞 API
 * 每次 batch 结束后等待 2 分钟（加 0~5 秒随机抖动）再执行下一轮
 * 父进程退出时自动停止
 */
export function startBatchWorker() {
  log.info('batch worker started', { interval: BATCH_INTERVAL_MS })

  // 自循环 setTimeout：上一轮跑完才安排下一轮，从源头消除并发
  // 即便 runBatch 抛错也确保下一轮被排上，避免 worker 卡死
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

  // 启动时随机抖动 0~10s，避免多个 csc 实例同时起 worker 撞 API
  scheduleNext(Math.floor(Math.random() * 10_000))
}

// 如果直接运行此文件
const scriptPath = process.argv[1] || ''
if (
  scriptPath.endsWith('batchWorker.ts') ||
  scriptPath.endsWith('batchWorker.js')
) {
  startBatchWorker()
}
