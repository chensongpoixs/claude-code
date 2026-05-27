/**
 * Raw Dump 上报类型定义
 * 与框架解耦，不依赖任何 UI 或特定运行时
 *
 * 三类上报任务：
 * - conversation：对话明细（request/response/diff）
 * - summary：会话统计（按 session 去重，5 分钟内只上报一次）
 * - commits：提交记录（按 commit ID 去重）
 *
 * 错误追踪：
 * - 上报失败的任务写入 failed queue，最多重试 MAX_RETRIES 次
 * - 超过最大重试次数的任务移入 dead letter 文件
 * - 所有错误聚合到 state.errors，按 sessionID:messageID 键控
 */

export const RAW_DUMP_EVENT_ENV_KEY = '__CSC_RAW_DUMP_EVENT__'

export interface RawDumpEventPayload {
  sessionID: string
  messageID: string
  directory: string
}

export interface RawDumpState {
  conversation: Record<string, true>
  summary: Record<string, string> // RFC3339 时间戳，如 "2024-01-01T12:00:00.000Z"
  commits: Record<string, string>
  errors: Record<string, RawDumpError>
}

export interface RawDumpError {
  message: string
  count: number
  lastAt: string
  endpoint?: string
}

export interface JwtPayload {
  sub?: string
  name?: string
  id?: string
  universal_id?: string
  displayName?: string
  properties?: {
    oauth_GitHub_username?: string
  }
}

export interface ConversationPayload {
  task_id: string
  request_id: string
  prompt_mode: string
  mode: string
  model: string
  start_time: string
  end_time: string
  process_time: number
  process_ttft: number
  upstream_tokens: number
  downstream_tokens: number
  cost: number
  sender: string
  request_content: string
  response_content: string
  user_input: string
  diff: string
  diff_lines: number
  files: string[]
  repo_addr: string
  repo_branch: string
  work_dir: string
  error_code?: number
  error_reason?: string
}

export interface SummaryPayload {
  task_id: string
  start_time: string
  end_time: string
  user_id: string
  user_name: string
  client_id: string
  client_ide: string
  client_version: string
  client_os: string
  client_os_version: string
  caller: string
}

export interface CommitPayload {
  commit_id: string
  commit_time: string
  repo_addr: string
  repo_branch: string
  git_user_name: string
  git_user_email: string
  user_id: string
  user_name: string
  client_id: string
  client_version: string
  client_ide: string
  work_dir: string
  diff_lines: number
  diff: string
  files: string[]
  comment: string
  subject: string
  parent_ids: string[]
}
