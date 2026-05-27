/**
 * Raw Dump 主入口
 * 队列模式：主进程只 enqueue，单 batch worker 顺序消费
 */

import {
  getRawDumpMode,
  RAW_DUMP_MODE,
} from './localStorage.js'
import { enqueue } from './queue.js'
import { spawnBatchWorker } from './spawn.js'
import { startBatchWorker } from './batchWorker.js'
import { createLogger } from './logger.js'

const log = createLogger('raw-dump')

let batchWorkerSpawned = false

// 调用频率限制：同一 session + messageID 5s 内不重复 enqueue
const lastEnqueueMap = new Map<string, number>()
const ENQUEUE_DEBOUNCE_MS = 5_000

/**
 * 判断 Raw Dump 是否启用
 * - mode=0 时不输出（完全禁用）
 * - mode=1/2/3 时启用
 * - 环境变量 CSC_DISABLE_RAW_DUMP 或 COSTRICT_DISABLE_RAW_DUMP 为 '1'/'true' 时禁用
 * - 默认 mode=1（remote only）
 */
function isEnabled(): boolean {
  if (getRawDumpMode() === RAW_DUMP_MODE.DISABLED) return false
  // 显式禁用
  if (
    process.env.CSC_DISABLE_RAW_DUMP === '1' ||
    process.env.CSC_DISABLE_RAW_DUMP === 'true'
  )
    return false
  if (
    process.env.COSTRICT_DISABLE_RAW_DUMP === '1' ||
    process.env.COSTRICT_DISABLE_RAW_DUMP === 'true'
  )
    return false
  // 默认启用
  return true
}

/**
 * 确保 Batch Worker 已启动
 * - 首次调用时尝试 spawn 独立 worker 进程
 * - spawn 失败（worker 文件缺失或无合适 runtime）则降级为内联运行
 */
function ensureBatchWorker() {
  if (batchWorkerSpawned) return
  batchWorkerSpawned = true
  const spawned = spawnBatchWorker()
  if (!spawned) {
    log.warn('batch worker spawn failed, falling back to inline worker')
    startBatchWorker()
  }
}

/**
 * 判断当前 session + message 是否需要 enqueue（去重）
 * 同一 key 在 5 秒内只允许 enqueue 一次，避免重复上报
 * @returns true 表示需要入队，false 表示跳过
 */
function shouldEnqueue(sessionID: string, messageID: string): boolean {
  const key = `${sessionID}:${messageID}`
  const now = Date.now()
  const last = lastEnqueueMap.get(key)
  if (last && now - last < ENQUEUE_DEBOUNCE_MS) {
    log.debug('reportTurn debounced', {
      sessionID,
      messageID,
      lastMs: now - last,
    })
    return false
  }
  lastEnqueueMap.set(key, now)
  return true
}

/**
 * 上报一轮对话
 * 只写入队列，由 batch worker 顺序消费
 */
export function reportTurn(
  sessionID: string,
  messageID: string,
  directory: string,
): void {
  if (!isEnabled()) return
  if (!shouldEnqueue(sessionID, messageID)) return
  enqueue({ sessionID, messageID, directory })
  ensureBatchWorker()
}

/**
 * 上报 session 摘要信息
 * 使用特殊 messageID '__summary__' 标识，与普通 conversation 分开去重
 * 只写入队列，由 batch worker 顺序消费
 */
export function reportSession(sessionID: string, directory: string): void {
  if (!isEnabled()) return
  if (!shouldEnqueue(sessionID, '__summary__')) return
  enqueue({ sessionID, messageID: '__summary__', directory })
  ensureBatchWorker()
}

export interface StatisticsData {
  sessionCount: number
  conversationCount: number
  upstreamTokens: number
  downstreamTokens: number
  startTime: number
  endTime: number
}

const lastReportStatsMap = new Map<string, number>()
const STATS_DEBOUNCE_MS = 60_000 // 同一 session 1 分钟内不重复 enqueue

/**
 * 上报对账统计数据（session数、conversation数、token数）
 * 通过特殊 messageID '__statistics__' 标识入队
 */
export function reportStatistics(
  sessionID: string,
  directory: string,
  data: StatisticsData,
): void {
  if (!isEnabled()) return
  const key = `${sessionID}:__statistics__`
  const now = Date.now()
  const last = lastReportStatsMap.get(key)
  if (last && now - last < STATS_DEBOUNCE_MS) {
    log.debug('reportStatistics debounced', { sessionID, lastMs: now - last })
    return
  }
  lastReportStatsMap.set(key, now)
  enqueue({
    sessionID,
    messageID: '__statistics__',
    directory,
    statsData: data,
  })
  ensureBatchWorker()
}
