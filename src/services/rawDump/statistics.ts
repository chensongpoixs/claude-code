/**
 * Raw Dump 统计信息管理
 * 使用全局变量维护当天的统计值，按天隔离
 * 有新的 conversation、summary、commit 时更新统计值
 * 上报完成后清理今日之前的记录
 */

import { readState, writeState } from './state.js'

/**
 * 当天统计数据结构
 */
export interface DailyStatistics {
  dateKey: string // YYYY/MM/DD 格式
  sessionCount: number
  conversationCount: number
  upstreamTokens: number
  downstreamTokens: number
  startTime: number // 当天最早一条记录的时间戳
  endTime: number // 当天最新一条记录的时间戳
}

/**
 * 获取当天日期 key，格式为 YYYY/MM/DD
 */
function getTodayKey(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}/${month}/${day}`
}

/**
 * 格式化时间戳为 ISO 字符串
 */
function formatIso(ms: number | undefined): string {
  if (!ms) return ''
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// 全局变量，维护当天的统计值
let globalStats: DailyStatistics = {
  dateKey: getTodayKey(),
  sessionCount: 0,
  conversationCount: 0,
  upstreamTokens: 0,
  downstreamTokens: 0,
  startTime: 0,
  endTime: 0,
}

/**
 * 重置全局统计值，重新初始化为当天
 */
function resetGlobalStats(): void {
  globalStats = {
    dateKey: getTodayKey(),
    sessionCount: 0,
    conversationCount: 0,
    upstreamTokens: 0,
    downstreamTokens: 0,
    startTime: 0,
    endTime: 0,
  }
}

/**
 * 检查并处理日期变更
 * 如果日期从昨天切换到今天，重置统计值
 */
function checkAndResetForNewDay(): void {
  const todayKey = getTodayKey()
  if (globalStats.dateKey !== todayKey) {
    resetGlobalStats()
  }
}

/**
 * 更新会话统计（当有新的 session 时调用）
 * @param timestamp 当前会话的时间戳
 */
export function incrementSession(timestamp: number): void {
  checkAndResetForNewDay()
  globalStats.sessionCount++
  updateTimeRange(timestamp)
}

/**
 * 更新对话统计（当有新的 conversation 上报成功时调用）
 * @param timestamp 当前对话的时间戳
 */
export function incrementConversation(timestamp: number): void {
  checkAndResetForNewDay()
  globalStats.conversationCount++
  updateTimeRange(timestamp)
}

/**
 * 添加 token 统计（当有新的 conversation 上报成功时调用）
 * @param upstream 上游 token 数量
 * @param downstream 下游 token 数量
 * @param timestamp 当前对话的时间戳
 */
export function addTokens(
  upstream: number,
  downstream: number,
  timestamp: number,
): void {
  checkAndResetForNewDay()
  globalStats.upstreamTokens += upstream
  globalStats.downstreamTokens += downstream
  updateTimeRange(timestamp)
}

/**
 * 更新时间范围
 * @param timestamp 时间戳
 */
function updateTimeRange(timestamp: number): void {
  if (globalStats.startTime === 0 || timestamp < globalStats.startTime) {
    globalStats.startTime = timestamp
  }
  if (globalStats.endTime === 0 || timestamp > globalStats.endTime) {
    globalStats.endTime = timestamp
  }
}

/**
 * 获取当前的全局统计值
 * @returns 当天的统计值副本
 */
export function getCurrentStatistics(): DailyStatistics {
  checkAndResetForNewDay()
  return { ...globalStats }
}

/**
 * 获取用于上报的统计数据
 * 用于 uploadStatistics 上报
 */
export function getStatisticsForUpload(): {
  sessionCount: number
  conversationCount: number
  upstreamTokens: number
  downstreamTokens: number
  startTime: number
  endTime: number
} {
  checkAndResetForNewDay()
  return {
    sessionCount: globalStats.sessionCount,
    conversationCount: globalStats.conversationCount,
    upstreamTokens: globalStats.upstreamTokens,
    downstreamTokens: globalStats.downstreamTokens,
    startTime: globalStats.startTime,
    endTime: globalStats.endTime,
  }
}

/**
 * 上报完成后清理历史记录
 * 读取 state，将 statistics 中今天之前的记录清理掉
 * 避免 state 文件无限增长
 */
export async function cleanupOldStatistics(): Promise<void> {
  try {
    const state = await readState()
    const todayKey = getTodayKey()

    // 过滤出今天的记录，清理掉昨天及之前的
    const cleanedStatistics: Record<string, string> = {}
    for (const [key, ts] of Object.entries(state.statistics)) {
      if (key === todayKey) {
        cleanedStatistics[key] = ts
      }
    }

    if (Object.keys(cleanedStatistics).length !== Object.keys(state.statistics).length) {
      state.statistics = cleanedStatistics
      await writeState(state)
    }
  } catch {
    // ignore cleanup errors
  }
}

const STATS_HOURLY_WINDOW_MS = 60 * 60 * 1000 // 同一天内，statistics 上报间隔 1 小时

/**
 * 检查是否需要上报 statistics
 * - 如果是当天：检查上次上报时间是否超过 1 小时间隔
 * - 如果不是当天（历史日期）：已上报过则不再上报
 * @param dateKey YYYY/MM/DD 格式的日期
 * @param state 当前状态
 * @returns true 表示需要上报，false 表示跳过
 */
export function shouldReportStatistics(
  dateKey: string,
  state: Awaited<ReturnType<typeof readState>>,
): boolean {
  const todayKey = getTodayKey()
  const lastReported = state.statistics[dateKey]

  if (!lastReported) {
    return true // 从未上报过，需要上报
  }

  if (dateKey !== todayKey) {
    return false // 历史日期已上报过，不再上报
  }

  // 当天：检查是否超过 1 小时间隔
  const lastTime = new Date(lastReported).getTime()
  const now = Date.now()
  return now - lastTime >= STATS_HOURLY_WINDOW_MS
}