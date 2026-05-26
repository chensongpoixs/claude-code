/**
 * Raw Dump Worker 进程启动器
 * 启动独立的 batch worker 顺序消费队列
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 解析 batch worker 入口脚本路径
 * - Dev 模式：使用 src/services/rawDump/batchWorker.ts
 * - Build 模式：从 dist/services/rawDump/batchWorker.js 定位到 dist 根目录
 */
function resolveWorkerPath(): string {
  const entry = process.execPath
  const isDev = path.basename(entry).toLowerCase().startsWith('bun')
  const __dirname = path.dirname(fileURLToPath(import.meta.url))

  if (isDev) {
    return path.resolve(__dirname, 'batchWorker.ts')
  }

  // Build mode: locate dist root (same pattern as ripgrep.ts / audio-capture-napi)
  // Bun.build strips the 'src/' prefix, so worker lands at dist/services/rawDump/batchWorker.js
  const parts = __dirname.split(path.sep)
  const distIdx = parts.lastIndexOf('dist')
  if (distIdx !== -1) {
    const distRoot = parts.slice(0, distIdx + 1).join(path.sep)
    return path.resolve(distRoot, 'services', 'rawDump', 'batchWorker.js')
  }

  return path.resolve(__dirname, 'batchWorker.js')
}

/**
 * 解析运行时环境
 * 优先检测当前进程是 bun 还是 node，返回对应运行时路径
 * 若无法检测（如编译后的独立二进制），尝试在 PATH 中查找 bun 或 node
 * @returns { entry: 运行时路径, isBun: 是否为 bun } 或 null
 */
function resolveRuntime(): { entry: string; isBun: boolean } | null {
  const execPath = process.execPath
  const basename = path.basename(execPath).toLowerCase()

  if (basename.startsWith('bun')) {
    return { entry: execPath, isBun: true }
  }
  if (basename.startsWith('node')) {
    return { entry: execPath, isBun: false }
  }

  // Compiled binary (e.g. csc-darwin-arm64): find bun or node on PATH
  if (typeof Bun !== 'undefined' && Bun.which) {
    const bun = Bun.which('bun')
    if (bun) return { entry: bun, isBun: true }
    const node = Bun.which('node')
    if (node) return { entry: node, isBun: false }
  }

  return null
}

/**
 * 尝试 spawn 独立的 batch worker 进程
 * @returns 是否成功 spawn（false 表示应 fallback 到内联启动）
 */
export function spawnBatchWorker(): boolean {
  const workerPath = resolveWorkerPath()
  const runtime = resolveRuntime()

  // Worker file missing or no suitable runtime (compiled binary without external worker file)
  if (!existsSync(workerPath) || !runtime) {
    return false
  }

  const args = runtime.isBun ? ['run', workerPath] : [workerPath]

  try {
    const child = spawn(runtime.entry, args, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    })

    child.on('error', err => {
      console.error('[raw-dump] batch worker spawn error:', err.message)
    })

    child.unref()
    return true
  } catch {
    return false
  }
}
