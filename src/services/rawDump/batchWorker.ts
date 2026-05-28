/**
 * Raw Dump Batch Worker
 * 顺序消费队列，避免并发 429
 * 独立进程，通过自循环 setTimeout 严格串行执行
 *
 * 单队列设计：
 * - 队列常驻内存，进程启动时一次性加载
 * - 入队/移除时写文件，其他操作仅更新内存
 * - 任务失败但未超限：attemptCount++ 写回文件，下次 batch 重试
 *
 * 每轮 batch 三道防线：进程内重入保护 → 跨进程文件锁 → 消费后清空文件
 */

import {
  processIncompleteTasks,
} from './worker.js'
import {
  loadQueue,
  acquireLock,
  releaseLock,
  getQueue,
  clearQueue,
} from './queue.js'
import { readState, writeState } from './state.js'
import { createLogger } from './logger.js'

const log = createLogger('raw-dump-batch')

const BATCH_INTERVAL_MS = 120_000
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

/**
 * 执行一轮 batch 处理
 * 流程：获取锁 → 读 state 和队列 → 同步 tasks → 保存 state 和队列 → 逐个处理
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
      const newTasks = getQueue()

      if (newTasks.length === 0) {
        // 队列为空时，检查 state.tasks 是否有未完成的任务
        const hasIncomplete = Object.values(state.tasks).some(
          r => !r.lastUploadAt,
        )
        if (!hasIncomplete) {
          log.debug('queue empty, no incomplete tasks')
          return
        }
        log.debug('queue empty, but has incomplete tasks in state')
      }

      log.info(`processing ${newTasks.length} new tasks`)

      // 同步 tasks：根据 task-id:message-id 查询 state.tasks
      for (const task of newTasks) {
        const key = `${task.sessionID}:${task.messageID}`
        const existing = state.tasks[key]

        if (existing) {
          // 已存在该键，比较 lastEnqueuedAt 和当前请求的时间戳
          if (task.enqueuedAt > existing.lastEnqueuedAt) {
            // 当前请求更新，更新时间戳 lastEnqueuedAt，清掉 lastUploadAt，累加 taskCount
            existing.lastEnqueuedAt = task.enqueuedAt
            existing.lastUploadAt = ''
            existing.taskCount++
            log.debug('task updated, needs re-upload', {
              key,
              taskCount: existing.taskCount,
              lastEnqueuedAt: existing.lastEnqueuedAt,
            })
          }
          // 如果当前请求没有更新，则忽略
        } else {
          // 不存在，添加到 state.tasks 中，设置初值
          state.tasks[key] = {
            lastEnqueuedAt: task.enqueuedAt,
            lastUploadAt: '',
            taskCount: 1,
            attemptCount: 0,
            directory: task.directory,
          }
          log.debug('task added to tracking', {
            key,
            lastEnqueuedAt: task.enqueuedAt,
          })
        }
      }

      // 保存 state 到磁盘
      await writeState(state)

      // 清掉队列并且把队列内容更新到磁盘文件
      clearQueue()

      log.info(`tracking ${Object.keys(state.tasks).length} tasks total`)

      // 处理 state.tasks 中未完成的任务
      await processIncompleteTasks(state)

      // 再次保存 state（更新 lastUploadAt）
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
