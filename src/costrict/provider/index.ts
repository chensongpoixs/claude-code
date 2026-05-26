/**
 * CoStrict 查询入口
 * 复用 OpenAI 兼容路径，注入 CoStrict 自定义 fetch 和 baseURL
 */

import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { SDKAssistantMessageError } from '../../entrypoints/agentSdkTypes.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'
import type {
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  AssistantMessage,
} from '../../types/message.js'
import type { Tools } from '../../Tool.js'
import type { Options } from '../../services/api/claude.js'
import OpenAI from 'openai'
import { getProxyFetchOptions } from '../../utils/proxy.js'
import { getUserAgent } from '../../utils/http.js'
import {
  anthropicMessagesToOpenAI,
  anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI,
  adaptOpenAIStreamToAnthropic,
} from '@ant/model-provider'
import { normalizeMessagesForAPI } from '../../utils/messages.js'
import { toolToAPISchema } from '../../utils/api.js'
import { logForDebugging } from '../../utils/debug.js'
import { addToTotalSessionCost } from '../../cost-tracker.js'
import { calculateUSDCost } from '../../utils/modelCost.js'
import {
  createAssistantAPIErrorMessage,
  ensureToolResultPairing,
  normalizeContentFromAPI,
} from '../../utils/messages.js'
import { randomUUID } from 'crypto'
import { parse as parsePartialJSON } from 'partial-json'
import { createCoStrictFetch } from './fetch.js'
import { resolveCoStrictModel } from './modelMapping.js'
import { getCoStrictBaseURL } from './auth.js'
import { loadCoStrictCredentials } from './credentials.js'
import {
  isOpenAIThinkingEnabled,
  resolveOpenAIMaxTokens,
} from '../../services/api/openai/requestBody.js'
import { fetchCoStrictModels, type CoStrictModel } from './models.js'
import {
  getMainThreadAgentType,
  getActiveSkillName,
} from '../../bootstrap/state.js'
import { getModelMaxOutputTokens } from '../../utils/context.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function mapErrorToSDKError(
  error: unknown,
): SDKAssistantMessageError | undefined {
  if (!(error instanceof Error)) return undefined
  // OpenAI SDK errors expose .status
  const status = (error as Record<string, unknown>).status
  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'authentication_failed'
    if (status === 429) return 'rate_limit'
    if (status === 402) return 'billing_error'
    if (status === 400) return 'invalid_request'
    return 'server_error'
  }
  return 'unknown'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
}

function tryParsePartialToolInput(
  rawInput: string,
): Record<string, unknown> | undefined {
  try {
    const parsed = parsePartialJSON(rawInput)
    return isPlainRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function getInvalidToolInputMessage(toolName: string): string {
  return `Model response error: invalid tool call arguments for ${toolName}. The tool call was not executed.`
}

type ToolCallStreamState = {
  index: number
  id: string
  name: string
  rawInput: string
  partialInput?: Record<string, unknown>
  finalParseError?: string
}

function contentContainsImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false

  return content.some(block => {
    if (!isRecord(block)) return false
    if (block.type === 'image') return true
    if (block.type === 'tool_result') {
      return contentContainsImage(block.content)
    }
    return false
  })
}

function messagesContainImages(messages: Message[]): boolean {
  return messages.some(message => {
    if (message.type !== 'user') return false
    if (!message.message) return false
    return contentContainsImage(message.message.content)
  })
}

function isNonMultimodalModelError(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('not a multimodal model') ||
    normalized.includes('does not support image') ||
    normalized.includes('does not support images')
  )
}

/**
 * CoStrict 查询路径
 * 与 queryModelOpenAI 结构相同，使用 CoStrict 自定义 fetch 和 baseURL
 */
export async function* queryModelCoStrict(
  messages: Message[],
  systemPrompt: SystemPrompt,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  try {
    // 1. 解析模型名
    const costrictModel = resolveCoStrictModel(options.model)

    // 2. 获取 CoStrict base URL
    const creds = await loadCoStrictCredentials()
    const baseUrl = getCoStrictBaseURL(creds?.base_url)
    const chatBaseURL = `${baseUrl}/chat-rag/api/v1`

    // 3. 从模型列表获取 maxTokens 相关参数
    let defaultMaxTokens = getModelMaxOutputTokens(costrictModel).upperLimit
    let maxTokensParamKey: string = 'max_tokens'
    let modelInfo: CoStrictModel | undefined
    if (creds?.access_token) {
      try {
        const modelList = await fetchCoStrictModels(baseUrl, creds.access_token)
        modelInfo = modelList.find(m => m.id === costrictModel)
        if (modelInfo) {
          maxTokensParamKey = modelInfo.maxTokensKey || 'max_tokens'
          if (modelInfo.maxTokens != null) {
            defaultMaxTokens = modelInfo.maxTokens
          }
        }
      } catch {
        // 获取模型列表失败，使用默认值
      }
    }
    const maxTokensValue = resolveOpenAIMaxTokens(
      defaultMaxTokens,
      options.maxOutputTokensOverride,
    )

    // 4. 规范化消息
    const messagesForAPI = ensureToolResultPairing(
      normalizeMessagesForAPI(messages, tools),
    )
    if (
      modelInfo?.supportsImages === false &&
      messagesContainImages(messagesForAPI)
    ) {
      yield createAssistantAPIErrorMessage({
        content: `CoStrict API Error: Model ${costrictModel} does not support image input. Switch to a multimodal or vision-capable model and try again.`,
        apiError: 'api_error',
      })
      return
    }

    // 5. 构建工具 schema
    const toolSchemas = await Promise.all(
      tools.map(tool =>
        toolToAPISchema(tool, {
          getToolPermissionContext: options.getToolPermissionContext,
          tools,
          agents: options.agents,
          allowedAgentTypes: options.allowedAgentTypes,
          model: options.model,
        }),
      ),
    )
    const standardTools = toolSchemas.filter(
      (t): t is BetaToolUnion & { type: string } => {
        const anyT = t as unknown as Record<string, unknown>
        return (
          anyT.type !== 'advisor_20260301' && anyT.type !== 'computer_20250124'
        )
      },
    )

    // 6. 转换为 OpenAI 格式
    // 根据模型名称自动检测是否启用thinking模式
    const enableThinking = isOpenAIThinkingEnabled(costrictModel)
    const openaiMessages = anthropicMessagesToOpenAI(
      messagesForAPI,
      systemPrompt,
      { enableThinking },
    )
    const openaiTools = anthropicToolsToOpenAI(standardTools)
    const openaiToolChoice = anthropicToolChoiceToOpenAI(options.toolChoice)

    // 7. 创建专用的 CoStrict OpenAI 客户端（不缓存，每次使用新的 fetch）
    const costrictFetch = createCoStrictFetch({
      agentType: getMainThreadAgentType() ?? getActiveSkillName(),
    })
    const client = new OpenAI({
      apiKey: 'costrict-managed', // 实际 token 由 createCoStrictFetch 注入
      baseURL: chatBaseURL,
      maxRetries: 0,
      timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
      dangerouslyAllowBrowser: true,
      fetchOptions: getProxyFetchOptions({
        forAnthropicAPI: false,
      }) as any,
      fetch: costrictFetch as any,
      defaultHeaders: { 'User-Agent': getUserAgent() },
    })

    logForDebugging(
      `[CoStrict] model=${costrictModel}, baseURL=${chatBaseURL}, messages=${openaiMessages.length}, tools=${openaiTools.length}`,
    )

    // 8. 调用 API（流式）
    const requestBody: Record<string, unknown> = {
      model: costrictModel,
      messages: openaiMessages,
      ...(openaiTools.length > 0 && {
        tools: openaiTools,
        ...(openaiToolChoice && {
          tool_choice:
            openaiToolChoice as OpenAI.Chat.Completions.ChatCompletionToolChoiceOption,
        }),
      }),
      stream: true,
      stream_options: { include_usage: true },
      [maxTokensParamKey]: maxTokensValue,
      ...(enableThinking && {
        thinking: { type: 'enabled' },
        enable_thinking: true,
        chat_template_kwargs: { thinking: true },
      }),
      ...(!enableThinking &&
        options.temperatureOverride !== undefined && {
          temperature: options.temperatureOverride,
        }),
    }
    const stream = await client.chat.completions.create(
      requestBody as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      { signal },
    )

    // 9. 转换流并 yield 事件
    const adaptedStream = adaptOpenAIStreamToAnthropic(stream, costrictModel)

    const contentBlocks: Record<number, any> = {}
    const toolCallStates = new Map<number, ToolCallStreamState>()
    let partialMessage: any
    let stopReason: string | null = null
    let usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
    let ttftMs = 0
    const start = Date.now()
    const finalizeToolCallStates = () => {
      for (const state of toolCallStates.values()) {
        try {
          const parsed = JSON.parse(state.rawInput)
          if (!isPlainRecord(parsed)) {
            state.finalParseError = getInvalidToolInputMessage(state.name)
          }
        } catch {
          state.finalParseError = getInvalidToolInputMessage(state.name)
        }
      }
    }
    const assembleFinalAssistantOutputs = (): (
      | AssistantMessage
      | SystemAPIErrorMessage
    )[] => {
      const outputs: (AssistantMessage | SystemAPIErrorMessage)[] = []
      if (!partialMessage) return outputs

      const allBlocksWithIndices = Object.keys(contentBlocks)
        .sort((a, b) => Number(a) - Number(b))
        .map(k => ({ index: Number(k), block: contentBlocks[Number(k)] }))
        .filter(entry => Boolean(entry.block))
      const allBlocks = allBlocksWithIndices.map(entry => entry.block)

      if (allBlocks.length > 0) {
        for (const { index, block } of allBlocksWithIndices) {
          if (block?.type !== 'tool_use') continue
          const state = toolCallStates.get(index)
          if (!state) continue
          block.input = state.rawInput
          if (state.finalParseError) {
            block.invalidToolCallError = state.finalParseError
          }
        }

        outputs.push({
          message: {
            ...partialMessage,
            content: normalizeContentFromAPI(
              allBlocks,
              tools,
              options.agentId,
              { preserveInvalidToolCall: true },
            ),
            usage,
            stop_reason: stopReason,
            stop_sequence: null,
          },
          requestId: undefined,
          type: 'assistant',
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
        } as AssistantMessage)
      }

      if (stopReason === 'max_tokens') {
        outputs.push(
          createAssistantAPIErrorMessage({
            content:
              `Output truncated: response exceeded the ${maxTokensValue} token limit. ` +
              `Set OPENAI_MAX_TOKENS or CLAUDE_CODE_MAX_OUTPUT_TOKENS to override.`,
            apiError: 'max_output_tokens',
            error: 'max_output_tokens',
          }),
        )
      }

      return outputs
    }

    for await (const event of adaptedStream) {
      switch (event.type) {
        case 'message_start': {
          partialMessage = (event as any).message
          ttftMs = Date.now() - start
          if ((event as any).message?.usage) {
            usage = { ...usage, ...(event as any).message.usage }
          }
          break
        }
        case 'content_block_start': {
          const idx = (event as any).index
          const cb = (event as any).content_block
          if (cb.type === 'tool_use') {
            contentBlocks[idx] = { ...cb, input: '' }
            toolCallStates.set(idx, {
              index: idx,
              id: String(cb.id ?? ''),
              name: typeof cb.name === 'string' ? cb.name : '',
              rawInput: '',
            })
          } else if (cb.type === 'text') {
            contentBlocks[idx] = { ...cb, text: '' }
          } else if (cb.type === 'thinking') {
            contentBlocks[idx] = { ...cb, thinking: '', signature: '' }
          } else {
            contentBlocks[idx] = { ...cb }
          }
          break
        }
        case 'content_block_delta': {
          const idx = (event as any).index
          const delta = (event as any).delta
          const block = contentBlocks[idx]
          if (!block) break
          if (delta.type === 'text_delta') {
            block.text = (block.text || '') + delta.text
          } else if (delta.type === 'input_json_delta') {
            const fragment = String(delta.partial_json ?? '')
            block.input = (block.input || '') + fragment
            const state = toolCallStates.get(idx)
            if (state) {
              state.rawInput += fragment
              const partialInput = tryParsePartialToolInput(state.rawInput)
              if (partialInput) {
                state.partialInput = partialInput
                ;(delta as Record<string, unknown>).parsed_tool_input =
                  partialInput
              }
            }
          } else if (delta.type === 'thinking_delta') {
            block.thinking = (block.thinking || '') + delta.thinking
          } else if (delta.type === 'signature_delta') {
            block.signature = delta.signature
          }
          break
        }
        case 'content_block_stop': {
          // Block accumulation is complete; emit one AssistantMessage at
          // message_stop so reasoning/text/tool blocks stay in a single turn.
          break
        }
        case 'message_delta': {
          const deltaUsage = (event as any).usage
          if (deltaUsage) usage = { ...usage, ...deltaUsage }
          if ((event as any).delta?.stop_reason != null) {
            stopReason = (event as any).delta.stop_reason
          }
          break
        }
        case 'message_stop': {
          if (partialMessage) {
            finalizeToolCallStates()
            for (const output of assembleFinalAssistantOutputs()) {
              yield output
            }
            partialMessage = null
            toolCallStates.clear()
          }
          break
        }
      }

      if (
        event.type === 'message_stop' &&
        usage.input_tokens + usage.output_tokens > 0
      ) {
        const costUSD = calculateUSDCost(costrictModel, usage as any)
        addToTotalSessionCost(costUSD, usage as any, options.model)
      }

      yield {
        type: 'stream_event',
        event,
        ...(event.type === 'message_start' ? { ttftMs } : undefined),
      } as StreamEvent
    }

    if (partialMessage) {
      finalizeToolCallStates()
      for (const output of assembleFinalAssistantOutputs()) {
        yield output
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logForDebugging(`[CoStrict] Error: ${errorMsg}`, { level: 'error' })
    yield createAssistantAPIErrorMessage({
      content: isNonMultimodalModelError(errorMsg)
        ? 'CoStrict API Error: The current model does not support image input. Switch to a multimodal or vision-capable model and try again.'
        : `CoStrict API Error: ${errorMsg}`,
      apiError: 'api_error',
      error: mapErrorToSDKError(error),
    })
  }
}
