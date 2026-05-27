/**
 * Raw Dump 任务队列
 * 主进程只写队列，独立 batch worker 顺序消费
 *
 * 单一队列设计（csc-workq-queue.jsonl）：
 * - 队列常驻内存，进程启动时一次性加载，后续操作均在内存中进行
 * - 任务入队/移除时写文件（其他操作仅更新内存）
 * - 成功则移除；彻底失败（attemptCount >= MAX_ATTEMPTS）也移除
 * - 失败但未超限：attemptCount++ 后写回文件，下次 batch 重试
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'path'
import type { StatisticsData } from './index.js'

const QUEUE_FILE = path.join(os.homedir(), '.claude', 'raw-dump', 'csc-work-queue.jsonl')
const LOCK_FILE = path.join(os.homedir(), '.claude', 'raw-dump', 'csc-work-queue.lock')

export const MAX_ATTEMPTS = 4 // 最多尝试次数

export interface QueueTask {
  sessionID: string
  messageID: string
  directory: string
  enqueuedAt: string // RFC3339 format, e.g. "2026-05-27T10:00:00.000Z"
  attemptCount: number
  statsData?: StatisticsData
}

// ----------- 内存中的队列 -----------
let queue: QueueTask[] = []
let queueLoaded = false

/**
 * 从磁盘加载队列到内存，只在进程启动时调用一次
 */
export async function loadQueue(): Promise<void> {
  if (queueLoaded) return
  try {
    const text = await fs.readFile(QUEUE_FILE, 'utf-8')
    queue = text
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
    queue = []
  }
  queueLoaded = true
}

/**
 * 将内存中的队列同步写回磁盘（仅在入队/移除时调用）
 */
export async function flushQueue(): Promise<void> {
  const lines = queue.map(t => JSON.stringify(t)).join('\n') + '\n'
  await fs.writeFile(QUEUE_FILE, lines, 'utf-8')
}

/**
 * 将任务追加到队列（内存 + 文件）
 * 写入失败被静默吞掉，不影响主流程
 */
export function enqueue(task: Omit<QueueTask, 'enqueuedAt' | 'attemptCount'>): void {
  const item: QueueTask = { ...task, enqueuedAt: new Date().toISOString(), attemptCount: 0 }
  queue.push(item)
  // 同步写文件，不阻塞主进程 event loop
  fs.writeFile(QUEUE_FILE, JSON.stringify(item) + '\n', { flag: 'a', encoding: 'utf-8' }).catch(() => {})
}

/**
 * 从内存队列中移除任务（成功或彻底失败时调用）
 * @param key sessionID:messageID
 */
export function removeTask(key: string): void {
  queue = queue.filter(t => `${t.sessionID}:${t.messageID}` !== key)
  flushQueue().catch(() => {})
}

/**
 * 消费队首任务（不移除，仅返回引用）
 * 用于在处理前 peek，失败时自行更新 attemptCount 再写回
 */
export function peekTask(): QueueTask | undefined {
  return queue[0]
}

/**
 * 获取当前内存队列快照
 */
export function getQueue(): QueueTask[] {
  return [...queue]
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
        try {
          process.kill(pid, 0)
          return false
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
