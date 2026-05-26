/**
 * Raw Dump 任务队列
 * 主进程只写队列，独立 batch worker 顺序消费
 */

import { appendFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const QUEUE_FILE = path.join(
  os.homedir(),
  '.claude',
  'csc-raw-dump-queue.jsonl',
)
const LOCK_FILE = path.join(os.homedir(), '.claude', 'csc-raw-dump.lock')

export interface QueueTask {
  sessionID: string
  messageID: string
  directory: string
  enqueuedAt: number
}

/**
 * 将任务追加到队列文件（JSONL 格式）
 * 使用 fire-and-forget 异步写入，避免阻塞主进程 event loop
 * 写入失败被静默吞掉，不影响主流程
 */
export function enqueue(task: Omit<QueueTask, 'enqueuedAt'>): void {
  const item: QueueTask = { ...task, enqueuedAt: Date.now() }
  // 使用 fire-and-forget 异步写入，避免阻塞主进程 event loop
  fs.appendFile(QUEUE_FILE, JSON.stringify(item) + '\n', 'utf-8').catch(
    () => {},
  )
}

/**
 * 从队列文件读取所有待处理的 task
 * - 按行解析 JSONL，每行一个 task
 * - 解析失败或空文件返回空数组
 */
export async function readQueue(): Promise<QueueTask[]> {
  try {
    const text = await fs.readFile(QUEUE_FILE, 'utf-8')
    return text
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line) as QueueTask
        } catch {
          return null
        }
      })
      .filter((t): t is QueueTask => t !== null)
  } catch {
    return []
  }
}

/**
 * 清空队列文件（truncate 为空）
 * 在 batch worker 读取队列后立即调用，避免处理期间积压的任务在下一轮重复消费
 */
export async function clearQueue(): Promise<void> {
  try {
    await fs.writeFile(QUEUE_FILE, '', 'utf-8')
  } catch {
    // ignore
  }
}

/**
 * 尝试获取 batch worker 运行锁
 * - 读取锁文件中的 PID，若进程仍存在则返回 false（已有 worker 在运行）
 * - 若锁文件不存在或持有进程已退出，则抢占锁
 */
export async function acquireLock(): Promise<boolean> {
  try {
    try {
      const stat = await fs.readFile(LOCK_FILE, 'utf-8')
      const pid = parseInt(stat, 10)
      if (!isNaN(pid) && pid !== process.pid) {
        // 检查进程是否还在运行
        try {
          process.kill(pid, 0)
          return false // 已有 worker 在运行
        } catch {
          // 进程已退出，可以抢占锁
        }
      }
    } catch {
      // lock 文件不存在
    }
    await fs.writeFile(LOCK_FILE, String(process.pid), 'utf-8')
    return true
  } catch {
    return false
  }
}

/**
 * 释放 batch worker 运行锁（清空锁文件内容）
 */
export async function releaseLock(): Promise<void> {
  try {
    await fs.writeFile(LOCK_FILE, '', 'utf-8')
  } catch {
    // ignore
  }
}
