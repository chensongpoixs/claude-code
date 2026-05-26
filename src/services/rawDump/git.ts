/**
 * Raw Dump Git 辅助函数
 * 仅依赖 node:child_process，与框架解耦
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * 封装 git 命令执行的通用逻辑
 * - 所有 git 命令使用相同参数：cwd、encoding、maxBuffer
 * - 失败时返回空字符串（而非抛异常）
 */
async function gitExec(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024, // 50MB
      windowsHide: true,
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

/**
 * 获取 Git 仓库信息
 * - remote origin URL（仓库地址）
 * - 当前分支名
 * - git 用户名和邮箱
 */
export async function getRepoInfo(cwd: string) {
  const [repoAddr, repoBranch, gitUserName, gitUserEmail] = await Promise.all([
    gitExec(['remote', 'get-url', 'origin'], cwd),
    gitExec(['branch', '--show-current'], cwd),
    gitExec(['config', 'user.name'], cwd),
    gitExec(['config', 'user.email'], cwd),
  ])

  return {
    repo_addr: repoAddr,
    repo_branch: repoBranch,
    git_user_name: gitUserName,
    git_user_email: gitUserEmail,
  }
}

export async function getRawDiff(
  cwd: string,
  from?: string,
  to?: string,
): Promise<string> {
  if (from && to && from !== to) {
    return gitExec(['diff', '--no-ext-diff', from, to], cwd)
  }
  // Fallback: diff working tree against HEAD
  return gitExec(['diff', 'HEAD'], cwd)
}

/**
 * 获取当前工作区与 HEAD 的 diff（未提交的变更）
 */
export async function getWorkingTreeDiff(cwd: string): Promise<string> {
  return gitExec(['diff', 'HEAD'], cwd)
}

/**
 * 统计 diff 中的行数（新增行数，不含 diff header）
 * 统计以 + 开头但不是 +++ 的行
 */
export function countDiffLines(diff: string): number {
  let count = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) count++
  }
  if (count === 0 && diff.trim()) return diff.trim().split('\n').length
  return count
}

/**
 * 从 unified diff 字符串中提取涉及的文件路径列表
 * 解析 +++ b/、--- a/、diff --git a/ b/ 三种路径格式
 */
export function extractFilesFromDiff(diff: string): string[] {
  const files = new Set<string>()
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) files.add(line.slice(6).trim())
    else if (line.startsWith('--- a/')) files.add(line.slice(6).trim())
    else if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/)
      if (match?.[2]) files.add(match[2])
    }
  }
  return Array.from(files)
}

/**
 * 解析 git log 输出（format: %H|%aI|%an|%ae|%P|%s）
 * 将每行按 | 分割为 commit 信息，返回结构化数组
 */
export function parseCommitLog(output: string): Array<{
  commit_id: string
  commit_time: string
  git_user_name: string
  git_user_email: string
  parent_ids: string[]
  subject: string
}> {
  if (!output.trim()) return []
  return output
    .split('\n')
    .map(line => {
      const [
        commit_id,
        commit_time,
        git_user_name,
        git_user_email,
        parent_ids_str,
        ...rest
      ] = line.split('|')
      if (!commit_id || !git_user_email) return null
      const parent_ids = parent_ids_str
        ? parent_ids_str.trim().split(' ').filter(Boolean)
        : []
      return {
        commit_id,
        commit_time,
        git_user_name,
        git_user_email,
        parent_ids,
        subject: rest.join('|'),
      }
    })
    .filter((item): item is NonNullable<typeof item> => !!item)
}

/**
 * 获取 git commit 日志
 * - 若指定 lastCommit：获取该 commit 之后的所有新 commit
 * - 否则：获取最近一天的所有 commit
 * - 按 author 过滤（仅当前 git 用户提交的）
 * - 最多返回 50 条
 */
export async function getCommitLog(
  cwd: string,
  lastCommit?: string,
): Promise<string> {
  const authorEmail = await gitExec(['config', 'user.email'], cwd)
  const authorFilter = authorEmail ? ['--author', authorEmail] : []

  if (lastCommit) {
    return gitExec(
      [
        'log',
        `${lastCommit}..HEAD`,
        '--reverse',
        '--max-count=50',
        ...authorFilter,
        '--format=%H|%aI|%an|%ae|%P|%s',
      ],
      cwd,
    )
  }
  return gitExec(
    [
      'log',
      '--since=1 day ago',
      '--reverse',
      '--max-count=50',
      ...authorFilter,
      '--format=%H|%aI|%an|%ae|%P|%s',
    ],
    cwd,
  )
}

/**
 * 获取单个 commit 的完整 diff（包含文件变更统计）
 * 使用 --diff-filter=ACDMR 只显示新增(Add)、复制(Copy)、删除(Delete)、修改(Modify)、重命名(Rename) 的文件
 */
export async function getCommitDiff(
  cwd: string,
  commitId: string,
): Promise<string> {
  return gitExec(['show', '--format=', '--diff-filter=ACDMR', commitId], cwd)
}

/**
 * 截断 commit subject 为最多 150 字符
 * 用于上报时限制 comment 字段长度
 */
export function toCommitComment(subject: string): string {
  return Array.from(subject).slice(0, 150).join('')
}
