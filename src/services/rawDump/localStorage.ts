/**
 * Raw Dump 本地存储模式
 * 开启后上报数据不落服务端，仅写入本地 JSON 文件，用于排障和调试
 *
 * CSC_RAW_DUMP_MODE 语义：
 * - 0: 不输出
 * - 1: 输出到 remote（POST）
 * - 2: 输出到本地（writeLocalDump）
 * - 3: 同时输出到 remote 和 local
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_LOCAL_DIR = path.join(os.homedir(), '.claude', 'raw-dump')

export type RawDumpMode = 0 | 1 | 2 | 3

export const RAW_DUMP_MODE = {
  DISABLED: 0,
  REMOTE: 1,
  LOCAL: 2,
  BOTH: 3,
} as const

/**
 * 获取本地存储目录路径
 * 支持环境变量 CSC_RAW_DUMP_DIR 覆盖
 */
export function getLocalDumpDir(): string {
  return (process.env.CSC_RAW_DUMP_DIR || DEFAULT_LOCAL_DIR).replace(
    /\/$/,
    '',
  )
}

/**
 * 获取 Raw Dump 输出模式
 * - 0: 不输出（跳过所有上报）
 * - 1: 输出到 remote（POST）
 * - 2: 输出到本地（writeLocalDump）
 * - 3: 同时输出到 remote 和 local
 * 默认 1（remote only）
 */
export function getRawDumpMode(): RawDumpMode {
  const v = process.env.CSC_RAW_DUMP_MODE
  if (v === '0') return 0
  if (v === '2') return 2
  if (v === '3') return 3
  return 1
}

/**
 * 将上报数据写入本地 JSON 文件（用于本地调试模式）
 * - 按 task_id 分目录存储
 * - 文件名包含时间戳、类型、request_id/commit_id
 * - 在 body 外层包装 _dumpMeta 元信息（类型、时间戳、API endpoint）
 */
export async function writeLocalDump(
  type: 'conversation' | 'summary' | 'commit',
  body: Record<string, unknown>,
): Promise<void> {
  const dir = getLocalDumpDir()
  const taskId = (body.task_id as string) || (body.commit_id as string)|| 'unknown'
  const taskDir = path.join(dir, type, taskId)
  await fs.mkdir(taskDir, { recursive: true })

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
  const requestId =
    (body.request_id as string) || (body.commit_id as string) || (body.task_id as string) || 'unknown'
  const filename = `${timestamp}-${requestId}.json`
  const filePath = path.join(taskDir, filename)

  const payload = {
    _dumpMeta: {
      type,
      dumpedAt: new Date().toISOString(),
      endpoint:
        type === 'conversation'
          ? '/raw-store/task-conversation'
          : type === 'summary'
            ? '/raw-store/task-summary'
            : '/raw-store/commit',
    },
    ...body,
  }

  await fs.writeFile(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf-8')
}
