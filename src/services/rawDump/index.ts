/**
 * Raw Dump 主入口
 * 队列模式：主进程只 enqueue，单 batch worker 顺序消费
 */

import {
  ensureRawDumpDirCreated,
  getRawDumpMode,
  RAW_DUMP_MODE,
} from './localStorage.js'
import { enqueue } from './queue.js'
import { spawnBatchWorker } from './spawn.js'
import { startBatchWorker } from './batchWorker.js'
import { createLogger } from './logger.js'

const log = createLogger('raw-dump')

let batchWorkerSpawned = false

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
 * 上报一轮对话
 * 只写入队列，由 batch worker 顺序消费
 * reportTurn 代表有新的大模型调用（即对话），有信息变化需要上报
 * 去重放在执行任务的逻辑中（batchWorker 的 runBatch）
 */
export async function reportTurn(
  sessionID: string,
  messageID: string,
  directory: string,
): Promise<void> {
  if (!isEnabled()) return
  ensureRawDumpDirCreated()
  enqueue({ sessionID, messageID, directory })
  ensureBatchWorker()
}
