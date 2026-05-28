/**
 * Raw Dump 磁盘状态管理
 * 用于 conversation、summary、commits 的去重
 * 通过文件锁保证多进程并发读写安全
 *
 * 错误追踪（dead letter）：
 * - 超过最大重试次数的任务追加写入 dead letter jsonl 文件
 * - 路径: ~/.claude/raw-dump/csc-dead-letter.jsonl
 */

import { promises as fs, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RawDumpState, DeadLetterEntry, TaskRecord } from './types.js'

const STATE_DIR = path.join(os.homedir(), '.claude', 'raw-dump')
const STATE_FILE = path.join(STATE_DIR, 'csc-state.json')
const STATE_LOCK_FILE = path.join(STATE_DIR, 'csc-state.lock')
const DEAD_LETTER_FILE = path.join(STATE_DIR, 'csc-dead-letter.jsonl')

/**
 * 创建空的 RawDumpState 对象
 * 作为 state 文件不存在或解析失败时的默认值
 */
function createEmptyState(): RawDumpState {
  return {
    conversation: {},
    summary: {},
    commits: {},
    statistics: {},
    tasks: {},
  }
}

/**
 * 清理昨日之前的已完成上报的 conversation、summary、tasks 记录
 * commits 记录保留
 * @param state 待清理的 state 对象
 */
function cleanupOldRecords(state: RawDumpState): RawDumpState {
  const now = Date.now()
  // 获取昨日 0 点的时间戳
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  yesterday.setHours(0, 0, 0, 0)
  const yesterdayMs = yesterday.getTime()

  const cleanedConversation: Record<string, string> = {}
  for (const [key, ts] of Object.entries(state.conversation)) {
    if (!ts) continue
    const date = new Date(ts).getTime()
    if (date >= yesterdayMs) {
      cleanedConversation[key] = ts
    }
  }

  const cleanedSummary: Record<string, string> = {}
  for (const [key, ts] of Object.entries(state.summary)) {
    if (!ts) continue
    const date = new Date(ts).getTime()
    if (date >= yesterdayMs) {
      cleanedSummary[key] = ts
    }
  }

  const cleanedTasks: Record<string, TaskRecord> = {}
  for (const [key, record] of Object.entries(state.tasks)) {
    // 清理 lastUploadAt 非空且已超过昨日的记录
    if (record.lastUploadAt) {
      const date = new Date(record.lastUploadAt).getTime()
      if (date >= yesterdayMs) {
        cleanedTasks[key] = record
      }
    } else {
      // lastUploadAt 为空表示尚未处理完毕，保留
      cleanedTasks[key] = record
    }
  }

  return {
    ...state,
    conversation: cleanedConversation,
    summary: cleanedSummary,
    tasks: cleanedTasks,
  }
}

/**
 * 尝试获取 state 文件的进程锁
 * - 读取锁文件中的 PID，若进程仍存在则返回 false（锁被占用）
 * - 若锁文件不存在或持有进程已退出（zombie），则抢占锁
 * - 使用 kill(pid, 0) 检测进程是否存在
 */
function acquireStateLock(): boolean {
  try {
    try {
      const stat = readFileSync(STATE_LOCK_FILE, 'utf-8')
      const pid = parseInt(stat, 10)
      if (!isNaN(pid) && pid !== process.pid) {
        try {
          process.kill(pid, 0)
          return false // 其他进程持有锁
        } catch {
          // 进程已退出，锁是陈旧的，可以抢占
        }
      }
    } catch {
      // 锁文件不存在
    }
    writeFileSync(STATE_LOCK_FILE, String(process.pid), 'utf-8')
    return true
  } catch {
    return false
  }
}

/**
 * 释放 state 文件锁（清空锁文件内容）
 */
function releaseStateLock(): void {
  try {
    writeFileSync(STATE_LOCK_FILE, '', 'utf-8')
  } catch {
    // ignore
  }
}

/**
 * 带锁执行异步函数
 * - 循环尝试获取锁，超时 5 秒后降级为无锁执行（避免永久挂起）
 * - 执行完成后无论成功与否都释放锁（finally 块保证）
 */
async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now()
  while (!acquireStateLock()) {
    if (Date.now() - start > 5_000) {
      // 5 秒超时：降级为无锁执行，避免永久挂起
      break
    }
    await new Promise(r => setTimeout(r, 10))
  }
  try {
    return await fn()
  } finally {
    releaseStateLock()
  }
}

/**
 * 从磁盘读取 state 文件
 * - 带文件锁，保证多进程读写安全
 * - 解析失败或文件不存在时返回空 state
 */
export async function readState(): Promise<RawDumpState> {
  return withStateLock(async () => {
    try {
      const text = await fs.readFile(STATE_FILE, 'utf-8')
      const parsed = JSON.parse(text) as Partial<RawDumpState>
      const state: RawDumpState = {
        conversation: parsed.conversation ?? {},
        summary: parsed.summary ?? {},
        commits: parsed.commits ?? {},
        statistics: parsed.statistics ?? {},
        tasks: parsed.tasks ?? {},
      }
      return cleanupOldRecords(state)
    } catch {
      return createEmptyState()
    }
  })
}

/**
 * 将 state 对象写入磁盘
 * - 带文件锁，保证多进程读写安全
 * - 自动创建目录（recursive: true）
 * - JSON 格式化输出（便于调试）
 */
export async function writeState(state: RawDumpState): Promise<void> {
  return withStateLock(async () => {
    await fs.mkdir(STATE_DIR, { recursive: true })
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
  })
}

export async function readDeadLetter(): Promise<DeadLetterEntry[]> {
  try {
    const text = await fs.readFile(DEAD_LETTER_FILE, 'utf-8')
    return text
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as DeadLetterEntry)
  } catch {
    return []
  }
}

export async function appendDeadLetter(entry: DeadLetterEntry): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true })
  await fs.writeFile(DEAD_LETTER_FILE, JSON.stringify(entry) + '\n', {
    flag: 'a',
    encoding: 'utf-8',
  })
}
