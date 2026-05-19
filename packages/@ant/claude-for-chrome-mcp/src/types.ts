/** Optional util.format detail; call sites pass caught exceptions. */
export type LoggerDetail = Error | NodeJS.ErrnoException

export function toLoggerDetail(detail: unknown): LoggerDetail | undefined {
  return detail instanceof Error ? detail : undefined
}

export interface Logger {
  info: (message: string, detail?: LoggerDetail) => void
  error: (message: string, detail?: LoggerDetail) => void
  warn: (message: string, detail?: LoggerDetail) => void
  debug: (message: string, detail?: LoggerDetail) => void
  silly: (message: string, detail?: LoggerDetail) => void
}

export type ChromeBridgeConnectionErrorType =
  | 'no_user_id'
  | 'no_oauth_token'
  | 'websocket_error'

/** Metadata shapes emitted by bridgeClient trackEvent calls. */
export type ChromeBridgeToolCallMetadata = {
  tool_name: string
  tool_use_id: string
  duration_ms?: number
  timeout_ms?: number
  error_message?: string
}

export type ChromeBridgeConnectionFailedMetadata = {
  duration_ms: number
  error_type: ChromeBridgeConnectionErrorType
  reconnect_attempt: number
}

export type ChromeBridgeConnectionStartedMetadata = {
  bridge_url: string
}

export type ChromeBridgeDisconnectedMetadata = {
  close_code: number
  duration_since_connect_ms: number
  reconnect_attempt: number
}

export type ChromeBridgeConnectionSucceededMetadata = {
  duration_ms: number
  status: 'paired' | 'waiting'
}

export type ChromeBridgeReconnectExhaustedMetadata = {
  total_attempts: number
}

export type ChromeBridgeTrackEventMetadata =
  | ChromeBridgeToolCallMetadata
  | ChromeBridgeConnectionFailedMetadata
  | ChromeBridgeConnectionStartedMetadata
  | ChromeBridgeDisconnectedMetadata
  | ChromeBridgeConnectionSucceededMetadata
  | ChromeBridgeReconnectExhaustedMetadata
  | null

export type PermissionMode =
  | 'ask'
  | 'skip_all_permission_checks'
  | 'follow_a_plan'

export interface BridgeConfig {
  /** Bridge WebSocket base URL (e.g., wss://bridge.claudeusercontent.com) */
  url: string
  /** Returns the user's account UUID for the connection path */
  getUserId: () => Promise<string | undefined>
  /** Returns a valid OAuth token for bridge authentication */
  getOAuthToken: () => Promise<string | undefined>
  /** Optional dev user ID for local development (bypasses OAuth) */
  devUserId?: string
}

/** Metadata about a connected Chrome extension instance. */
export interface ChromeExtensionInfo {
  deviceId: string
  osPlatform?: string
  connectedAt: number
  name?: string
}

export interface ClaudeForChromeContext {
  serverName: string
  logger: Logger
  socketPath: string
  // Optional dynamic resolver for socket path. When provided, called on each
  // connection attempt to handle runtime conditions (e.g., TMPDIR mismatch).
  getSocketPath?: () => string
  // Optional resolver returning all available socket paths (for multi-profile support).
  // When provided, a socket pool connects to all sockets and routes by tab ID.
  getSocketPaths?: () => string[]
  clientTypeId: string // "desktop" | "claude-code"
  onToolCallDisconnected: () => string
  onAuthenticationError: () => void
  isDisabled?: () => boolean
  /** Bridge WebSocket configuration. When provided, uses bridge instead of socket. */
  bridgeConfig?: BridgeConfig
  /** If set, permission mode is sent to the extension immediately on bridge connection. */
  initialPermissionMode?: PermissionMode
  /** Optional callback to track telemetry events for bridge connections */
  trackEvent?: (
    eventName: string,
    metadata: ChromeBridgeTrackEventMetadata,
  ) => void
  /** Called when user pairs with an extension via the browser pairing flow. */
  onExtensionPaired?: (deviceId: string, name: string) => void
  /** Returns the previously paired deviceId, if any. */
  getPersistedDeviceId?: () => string | undefined
  /** Called when a remote extension is auto-selected (only option available). */
  onRemoteExtensionWarning?: (ext: ChromeExtensionInfo) => void
}

/**
 * Map Node's process.platform to the platform string reported by Chrome extensions
 * via navigator.userAgentData.platform.
 */
export function localPlatformLabel(): string {
  return process.platform === 'darwin'
    ? 'macOS'
    : process.platform === 'win32'
      ? 'Windows'
      : 'Linux'
}

/** Permission request forwarded from the extension to the desktop for user approval. */
export interface BridgePermissionRequest {
  /** Links to the pending tool_call */
  toolUseId: string
  /** Unique ID for this permission request */
  requestId: string
  /** Tool type, e.g. "navigate", "click", "execute_javascript" */
  toolType: string
  /** The URL/domain context */
  url: string
  /** Additional action data (click coordinates, text, etc.) */
  actionData?: Record<string, unknown>
}

/** Desktop response to a bridge permission request. */
export interface BridgePermissionResponse {
  requestId: string
  allowed: boolean
}

/** Per-call permission overrides, allowing each session to use its own permission state. */
export interface PermissionOverrides {
  permissionMode: PermissionMode
  allowedDomains?: string[]
  /** Callback invoked when the extension requests user permission via the bridge. */
  onPermissionRequest?: (request: BridgePermissionRequest) => Promise<boolean>
}

/** Shared interface for McpSocketClient and McpSocketPool */
export interface SocketClient {
  ensureConnected(): Promise<boolean>
  callTool(
    name: string,
    args: Record<string, unknown>,
    permissionOverrides?: PermissionOverrides,
  ): Promise<unknown>
  isConnected(): boolean
  disconnect(): void
  setNotificationHandler(
    handler: (notification: {
      method: string
      params?: Record<string, unknown>
    }) => void,
  ): void
  /** Set permission mode for the current session. Only effective on BridgeClient. */
  setPermissionMode?(
    mode: PermissionMode,
    allowedDomains?: string[],
  ): Promise<void>
  /** Switch to a different browser. Only available on BridgeClient. */
  switchBrowser?(): Promise<
    | {
        deviceId: string
        name: string
      }
    | 'no_other_browsers'
    | null
  >
}
