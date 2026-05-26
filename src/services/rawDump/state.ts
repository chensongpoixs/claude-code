/**
 * Raw Dump 磁盘状态管理
 * 用于 conversation、summary 和 commits 的去重
 * 通过文件锁保证多进程并发读写安全
 */

import { promises as fs, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RawDumpState } from './types.js'

const STATE_DIR = path.join(os.homedir(), '.claude')
const STATE_FILE = path.join(STATE_DIR, 'csc-raw-dump-state.json')
const STATE_LOCK_FILE = path.join(STATE_DIR, 'csc-raw-dump-state.lock')

/**
 * 创建空的 RawDumpState 对象
 * 作为 state 文件不存在或解析失败时的默认值
 */
function createEmptyState(): RawDumpState {
  return {
    conversation: {},
    summary: {},
    commits: {},
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
      return {
        conversation: parsed.conversation ?? {},
        summary: parsed.summary ?? {},
        commits: parsed.commits ?? {},
      }
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
