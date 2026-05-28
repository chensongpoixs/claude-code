/**
 * Raw Dump 上报类型定义
 * 与框架解耦，不依赖任何 UI 或特定运行时
 *
 * 三类上报任务：
 * - conversation：对话明细（request/response/diff）
 * - summary：会话统计（按 session 去重，5 分钟内只上报一次）
 * - commits：提交记录（按 commit ID 去重）
 *
 * 错误追踪（dead letter）：
 * - 超过最大重试次数的任务追加写入 dead letter jsonl 文件
 * - 路径: ~/.claude/raw-dump/csc-dead-letter.jsonl
 */

export const RAW_DUMP_EVENT_ENV_KEY = '__CSC_RAW_DUMP_EVENT__'

export interface RawDumpEventPayload {
  sessionID: string
  messageID: string
  directory: string
}

export interface TaskRecord {
  lastEnqueuedAt: string // RFC3339，最后一次收到该组请求的时间戳
  lastUploadAt: string // RFC3339，请求处理完毕的时间戳，为空表示尚未处理完毕，"DEAD_LETTER"表示已移至死信
  taskCount: number // 收到的该组请求总个数
  attemptCount: number // 已尝试次数，超过 MAX_ATTEMPTS 后移至 dead letter
  directory: string // 工作目录，用于定位 session 文件
}

export interface RawDumpState {
  conversation: Record<string, string> // key: "taskID:messageID", value: RFC3339 时间戳，未上报则为空字符串
  summary: Record<string, string> //key: task-id, value: 上报成功的时间戳， RFC3339格式，如 "2024-01-01T12:00:00.000Z"
  commits: Record<string, string> //key: repo-addr#branch#work-dir，value: 最后一个上报成功的commit-id
  statistics: Record<string, string> // key: YYYY/MM/DD, value: RFC3339 时间戳
  tasks: Record<string, TaskRecord> // key: "task-id:message-id"，值为任务跟踪记录
}

export interface DeadLetterEntry {
  sessionID: string
  messageID: string
  directory: string
  attemptCount: number
  error: string
  failedAt: string
  // 待上报的 HTTP 请求信息
  url?: string
  headers?: Record<string, string>
  body?: object
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

export interface StatisticsPayload {
  task_id: string
  start_time: string
  end_time: string
  user_id: string
  user_name: string
  client_id: string
  client_version: string
  session_count: number
  conversation_count: number
  upstream_tokens: number
  downstream_tokens: number
}
