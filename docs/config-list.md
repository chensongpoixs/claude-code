# Claude Code 配置清单

本文档列出了 Claude Code 所有可用的配置项，按维度和类型分类。

---

## 配置文件路径

### 全局/个人维度

| 路径 | 平台 | 说明 |
|------|------|------|
| `~/.claude.json` | All | 全局用户配置主文件（旧版，仍兼容） |
| `~/.claude/settings.json` | All | 新版用户设置文件（推荐） |
| `~/.claude/cowork_settings.json` | All | Co-work 模式下的用户设置 |
| `~/.claude/backups/` | All | 配置备份目录 |
| `~/.claude/teams/` | All | 团队配置目录 |
| `~/.claude/cache/changelog.md` | All | 更新日志缓存 |
| `~/.claude/plans/` | All | Plan 模式存储目录 |
| `~/.claude/projects/{project}/memory/` | All | 项目记忆文件存储 |

### 项目维度

| 路径 | 应提交Git | 说明 |
|------|-----------|------|
| `.claude/settings.json` | ✅ 是 | 项目共享设置 |
| `.claude/local-settings.json` | ❌ 否 | 本地私有设置（自动gitignore） |
| `.claude/mcp.json` | 可选 | MCP 服务器配置 |
| `.claude/agents/` | ✅ 是 | 自定义 Agent 定义 |
| `.claude/skills/` | ✅ 是 | 项目级 Skills |
| `.claude/hooks/` | ✅ 是 | 项目级 Hooks |

### 企业/策略维度

| 路径 | 平台 | 说明 |
|------|------|------|
| `/etc/claude/managed-settings.json` | Linux | 系统级托管配置 |
| `/Library/Application Support/Claude/managed-settings.json` | macOS | 系统级托管配置 |
| `%ProgramData%/Claude/managed-settings.json` | Windows | 系统级托管配置 |
| `managed-settings.d/*.json` | All | Drop-in 配置片段目录 |

---

## 环境变量清单

### API 配置

| 变量名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `ANTHROPIC_API_KEY` | string | - | Anthropic API 密钥 |
| `ANTHROPIC_BASE_URL` | string | `https://api.anthropic.com` | Anthropic API 基础 URL |
| `CLAUDE_CONFIG_DIR` | string | `~/.claude` | 配置目录覆盖 |

### Provider 选择（优先级从上到下）

| 变量名 | 类型 | 说明 |
|--------|------|------|
| `CLAUDE_CODE_USE_COSTRICT` | boolean | 使用 Costrict Provider |
| `CLAUDE_CODE_USE_OPENAI` | boolean | 使用 OpenAI 兼容 API |
| `CLAUDE_CODE_USE_GEMINI` | boolean | 使用 Google Gemini API |
| `CLAUDE_CODE_USE_GROK` | boolean | 使用 Grok/XAI API |
| `CLAUDE_CODE_USE_BEDROCK` | boolean | 使用 AWS Bedrock |
| `CLAUDE_CODE_USE_VERTEX` | boolean | 使用 Google Vertex AI |
| `CLAUDE_CODE_USE_FOUNDRY` | boolean | 使用 Anthropic Foundry |

### OpenAI 兼容配置

| 变量名 | 类型 | 说明 |
|--------|------|------|
| `OPENAI_API_KEY` | string | OpenAI API 密钥 |
| `OPENAI_BASE_URL` | string | OpenAI 基础 URL |
| `OPENAI_MODEL` | string | 默认模型（直接覆盖） |
| `OPENAI_DEFAULT_SONNET_MODEL` | string | Sonnet 级别模型映射 |
| `OPENAI_DEFAULT_OPUS_MODEL` | string | Opus 级别模型映射 |
| `OPENAI_DEFAULT_HAIKU_MODEL` | string | Haiku 级别模型映射 |
| `OPENAI_DEFAULT_*_MODEL_NAME` | string | 模型显示名称 |
| `OPENAI_DEFAULT_*_MODEL_DESCRIPTION` | string | 模型描述 |

### Gemini 配置

| 变量名 | 类型 | 说明 |
|--------|------|------|
| `GEMINI_API_KEY` | string | **必填** Gemini API 密钥 |
| `GEMINI_BASE_URL` | string | API 端点（默认：`https://generativelanguage.googleapis.com/v1beta`） |
| `GEMINI_MODEL` | string | 默认模型（最高优先级） |
| `GEMINI_DEFAULT_SONNET_MODEL` | string | Sonnet 级别模型映射 |
| `GEMINI_DEFAULT_OPUS_MODEL` | string | Opus 级别模型映射 |
| `GEMINI_DEFAULT_HAIKU_MODEL` | string | Haiku 级别模型映射 |
| `GEMINI_SMALL_FAST_MODEL` | string | 快速任务使用的模型 |

### Anthropic 模型覆盖

| 变量名 | 类型 | 说明 |
|--------|------|------|
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | string | 覆盖 Sonnet 模型 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | string | 覆盖 Opus 模型 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | string | 覆盖 Haiku 模型 |
| `ANTHROPIC_DEFAULT_*_MODEL_NAME` | string | 模型显示名称 |
| `ANTHROPIC_DEFAULT_*_MODEL_DESCRIPTION` | string | 模型描述 |
| `ANTHROPIC_CUSTOM_MODEL_OPTION` | string | 自定义模型选项 |
| `ANTHROPIC_CUSTOM_MODEL_OPTION_NAME` | string | 自定义模型显示名称 |
| `ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION` | string | 自定义模型描述 |

### Vertex AI 区域配置

| 变量名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `CLOUD_ML_REGION` | string | `us-east5` | 默认 Vertex 区域 |
| `VERTEX_REGION_CLAUDE_HAIKU_4_5` | string | - | Haiku 4.5 区域 |
| `VERTEX_REGION_CLAUDE_3_5_HAIKU` | string | - | 3.5 Haiku 区域 |
| `VERTEX_REGION_CLAUDE_3_5_SONNET` | string | - | 3.5 Sonnet 区域 |
| `VERTEX_REGION_CLAUDE_3_7_SONNET` | string | - | 3.7 Sonnet 区域 |
| `VERTEX_REGION_CLAUDE_4_1_OPUS` | string | - | Opus 4.1 区域 |
| `VERTEX_REGION_CLAUDE_4_0_OPUS` | string | - | Opus 4.0 区域 |
| `VERTEX_REGION_CLAUDE_4_6_SONNET` | string | - | Sonnet 4.6 区域 |
| `VERTEX_REGION_CLAUDE_4_5_SONNET` | string | - | Sonnet 4.5 区域 |
| `VERTEX_REGION_CLAUDE_4_0_SONNET` | string | - | Sonnet 4.0 区域 |

### 功能开关

| 变量名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `CLAUDE_CODE_SIMPLE` | boolean | `false` | 极简模式（等价于 `--bare`） |
| `FEATURE_BUDDY` | boolean | `false` | 启用 Buddy 功能 |
| `FEATURE_DAEMON` | boolean | `false` | 启用 Daemon 模式 |
| `FEATURE_BRIDGE_MODE` | boolean | `false` | 启用 Bridge/Remote Control 模式 |
| `FEATURE_BG_SESSIONS` | boolean | `false` | 启用后台会话 |
| `FEATURE_VOICE_MODE` | boolean | `true` | 启用语音模式（dev/build 默认开启） |
| `FEATURE_CHICAGO_MCP` | boolean | `true` | 启用 Computer Use（dev/build 默认开启） |
| `FEATURE_AGENT_TRIGGERS_REMOTE` | boolean | `true` | 启用 Agent 远程触发（dev/build 默认开启） |
| `FEATURE_TRANSCRIPT_CLASSIFIER` | boolean | `false` | 启用转录分类器 |
| `FEATURE_PROACTIVE` | boolean | `false` | 启用主动模式 |
| `FEATURE_KAIROS` | boolean | `false` | 启用 Kairos 模式 |
| `FEATURE_FORK_SUBAGENT` | boolean | `false` | 启用 Fork Subagent |
| `FEATURE_SSH_REMOTE` | boolean | `false` | 启用 SSH 远程 |
| `FEATURE_DIRECT_CONNECT` | boolean | `false` | 启用直接连接 |
| `FEATURE_TEMPLATES` | boolean | `false` | 启用模板 |
| `FEATURE_BYOC_ENVIRONMENT_RUNNER` | boolean | `false` | 启用 BYOC 环境运行器 |
| `FEATURE_SELF_HOSTED_RUNNER` | boolean | `false` | 启用自托管运行器 |
| `FEATURE_COORDINATOR_MODE` | boolean | `false` | 启用协调器模式 |
| `FEATURE_CCR_AUTO_CONNECT` | boolean | `false` | 启用 CCR 自动连接 |

### 行为控制

| 变量名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` | boolean | `false` | 禁用终端标题更新 |
| `CLAUDE_CODE_DISABLE_THINKING` | boolean | `false` | 禁用思考模式 |
| `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` | boolean | `false` | 禁用自适应思考 |
| `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` | boolean | `false` | 禁用非流式回退 |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | number | - | 最大输出 token 数 |
| `CLAUDE_CODE_EXTRA_BODY` | JSON | - | API 请求额外 body 参数（JSON对象） |
| `CLAUDE_CODE_EXTRA_METADATA` | JSON | - | 额外元数据（JSON对象） |
| `API_TIMEOUT_MS` | number | 300000 | API 超时时间（毫秒） |
| `CLAUDE_CODE_REMOTE` | boolean | `false` | 远程模式（调整超时为120s） |

### 缓存控制

| 变量名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `DISABLE_PROMPT_CACHING` | boolean | `false` | 禁用所有提示缓存 |
| `DISABLE_PROMPT_CACHING_HAIKU` | boolean | `false` | 禁用 Haiku 提示缓存 |
| `DISABLE_PROMPT_CACHING_SONNET` | boolean | `false` | 禁用 Sonnet 提示缓存 |
| `DISABLE_PROMPT_CACHING_OPUS` | boolean | `false` | 禁用 Opus 提示缓存 |
| `ENABLE_PROMPT_CACHING_1H_BEDROCK` | boolean | `false` | 启用 Bedrock 1小时缓存 |

### 流式传输

| 变量名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `CLAUDE_ENABLE_STREAM_WATCHDOG` | boolean | `true` | 启用流监控 |
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | number | 90000 | 流空闲超时（毫秒） |

### 开发/测试

| 变量名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `NODE_ENV` | string | - | 环境类型 (`test`, `development`, `production`) |
| `USER_TYPE` | string | - | 用户类型 (`ant` = 内部员工) |
| `IS_SANDBOX` | string | - | 沙箱模式 (`1` = 启用) |
| `CLAUDE_CODE_ENTRYPOINT` | string | - | 入口点标识 (`sdk-ts`, `sdk-py`, `local-agent`, `claude-desktop`) |
| `CLAUDE_CODE_USE_COWORK_PLUGINS` | boolean | `false` | 使用 Co-work 插件 |
| `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` | boolean | `false` | 同步插件安装 |
| `CLAUDE_CODE_BUBBLEWRAP` | boolean | `false` | 启用 Bubblewrap 沙箱 |
| `CLAUDE_CODE_ENABLE_XAA` | boolean | `false` | 启用 XAA（外部认证代理） |

### Raw Dump 数据上报

| 变量名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `CSC_DISABLE_RAW_DUMP` | boolean | `false` | 禁用数据上报（设为 `0` 或 `false` 表示启用） |
| `COSTRICT_DISABLE_RAW_DUMP` | boolean | `false` | 兼容 opencode 的禁用开关 |
| `CSC_RAW_DUMP_DEBUG` | boolean | `false` | 开启 raw dump 调试日志 |
| `CSC_RAW_DUMP_BASE_URL` | string | - | 自定义上报服务端地址 |
| `COSTRICT_RAW_DUMP_BASE_URL` | string | - | 兼容 opencode 的自定义上报地址 |
| `COSTRICT_BASE_URL` | string | `https://zgsm.sangfor.com` | CoStrict 服务地址 |
| `CSC_RAW_DUMP_MODE` | boolean | `false` | **本地留存模式**：数据只写入本地文件，不上报服务端 |
| `CSC_RAW_DUMP_DIR` | string | `~/.claude/raw-dump` | 本地留存目录 |

### Bash/终端

| 变量名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` | boolean | `false` | Bash 命令后恢复项目工作目录 |
| `SHELL` | string | `/bin/bash` | 默认 shell |
| `EDITOR` | string | - | 编辑器偏好 |
| `VISUAL` | string | - | 可视化编辑器偏好 |

### AWS 配置

| 变量名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `AWS_REGION` | string | `us-east-1` | AWS 区域 |
| `AWS_DEFAULT_REGION` | string | - | AWS 默认区域 |
| `AWS_ACCESS_KEY_ID` | string | - | AWS 访问密钥 |
| `AWS_SECRET_ACCESS_KEY` | string | - | AWS 秘密密钥 |
| `AWS_SESSION_TOKEN` | string | - | AWS 会话令牌 |
| `AWS_PROFILE` | string | - | AWS 配置文件 |

### GCP 配置

| 变量名 | 类型 | 说明 |
|--------|------|------|
| `GOOGLE_APPLICATION_CREDENTIALS` | string | GCP 服务账户密钥路径 |
| `GOOGLE_CLOUD_PROJECT` | string | GCP 项目 ID |

### Azure 配置

| 变量名 | 类型 | 说明 |
|--------|------|------|
| `AZURE_CLIENT_ID` | string | Azure 客户端 ID |
| `AZURE_CLIENT_SECRET` | string | Azure 客户端密钥 |
| `AZURE_TENANT_ID` | string | Azure 租户 ID |

### 内部/Anthropic 专用

| 变量名 | 类型 | 说明 |
|--------|------|------|
| `COO_RUNNING_ON_HOMESPACE` | boolean | 运行在 Homespace 环境 |
| `CLAUDE_CODE_MESSAGING_SOCKET` | string | 消息 socket 路径 |
| `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` | boolean | 禁用内置 Agent |
| `CLAUDE_CODE_COORDINATOR_MODE` | boolean | 启用协调器模式 |

---

## 设置源优先级

配置按以下顺序加载，**后加载的覆盖先加载的**：

```
1. userSettings      → ~/.claude/settings.json
2. projectSettings   → ./.claude/settings.json
3. localSettings     → ./.claude/local-settings.json
4. flagSettings      → --settings 指定的文件
5. policySettings    → managed-settings.json / 远程策略
```

---

## 配置项详细说明

### 全局配置 (GlobalConfig)

```typescript
{
  // 身份认证
  userID?: string                    // 用户唯一ID
  oauthAccount?: AccountInfo         // OAuth 账户信息
  primaryApiKey?: string             // 主API密钥

  // 外观
  theme: 'dark' | 'light'            // 主题
  editorMode?: 'normal' | 'vim'      // 编辑器模式
  verbose: boolean                   // 详细输出

  // 行为
  autoCompactEnabled: boolean        // 自动压缩
  showTurnDuration: boolean          // 显示每轮耗时
  diffTool: 'terminal' | 'auto'      // 差异工具
  fileCheckpointingEnabled: boolean  // 文件检查点
  terminalProgressBarEnabled: boolean // 终端进度条
  respectGitignore: boolean          // 遵守 .gitignore
  copyFullResponse: boolean          // 复制完整响应

  // 通知
  preferredNotifChannel: string      // 通知渠道
  taskCompleteNotifEnabled?: boolean // 任务完成通知
  inputNeededNotifEnabled?: boolean  // 需要输入通知
  agentPushNotifEnabled?: boolean    // Agent 推送通知

  // IDE
  autoConnectIde?: boolean           // 自动连接 IDE
  autoInstallIdeExtension?: boolean // 自动安装 IDE 扩展

  // 功能
  todoFeatureEnabled: boolean        // Todo 功能
  speculationEnabled?: boolean       // 推测执行
  permissionExplainerEnabled?: boolean // 权限解释器

  // 统计
  numStartups: number                // 启动次数
  memoryUsageCount: number           // 记忆使用次数
}
```

### 项目配置 (ProjectConfig)

```typescript
{
  // 权限
  allowedTools: string[]             // 允许的工具列表
  hasTrustDialogAccepted?: boolean   // 信任对话框已接受

  // MCP
  mcpServers?: Record<string, McpServerConfig>
  enabledMcpjsonServers?: string[]
  disabledMcpServers?: string[]

  // 会话
  activeWorktreeSession?: {...}
  remoteControlSpawnMode?: 'same-dir' | 'worktree'

  // 统计
  lastAPIDuration?: number
  lastCost?: number
  lastModelUsage?: Record<string, ModelUsage>
}
```

### 设置文件 Schema (settings.json)

```typescript
{
  $schema?: string                   // JSON Schema URL
  apiKeyHelper?: string              // API 密钥辅助脚本
  awsCredentialExport?: string       // AWS 凭证导出脚本
  awsAuthRefresh?: string            // AWS 认证刷新脚本
  gcpAuthRefresh?: string            // GCP 认证刷新命令

  permissions?: {
    allow?: PermissionRule[]         // 允许规则
    deny?: PermissionRule[]          // 拒绝规则
    ask?: PermissionRule[]           // 询问规则
    defaultMode?: string             // 默认权限模式
    additionalDirectories?: string[] // 额外目录
  }

  env?: Record<string, string>       // 环境变量

  hooks?: {
    preToolCall?: HookCommand[]
    postToolCall?: HookCommand[]
    preWrite?: HookCommand[]
    FileChanged?: HookCommand[]
    WorktreeCreate?: HookCommand[]
  }

  mcpServers?: Record<string, McpServerConfig>
  allowedMcpServers?: AllowedMcpServerEntry[]
  deniedMcpServers?: DeniedMcpServerEntry[]

  statusLine?: StatusLineConfig      // 状态栏配置
  diffMarketplaces?: ExtraKnownMarketplace[] // 额外市场

  remote?: {
    defaultEnv?: string              // 默认远程环境
    spawnOptions?: SpawnOptions      // 生成选项
  }

  ssh?: {
    configs: SshConfig[]             // SSH 配置列表
  }

  autoMemory?: {
    enabled?: boolean
    customDirectory?: string         // 自定义记忆目录
  }

  worktree?: {
    symlinkedWorktrees?: string[]    // 符号链接的工作区
  }

  // 企业策略
  strictPluginOnlyCustomization?: string[] // 锁定自定义表面
  disableBypassPermissionsMode?: 'disable'
  onlyManagedPermissionRules?: boolean
  onlyManagedHooks?: boolean
  onlyManagedMcpServers?: boolean
}
```

---

## 配置示例

### 基础项目配置

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": [
      { "tool": "Bash", "command": "npm *" },
      { "tool": "Bash", "command": "git *" },
      { "tool": "FileRead", "path": "src/**/*" },
      { "tool": "FileEdit", "path": "src/**/*" }
    ],
    "deny": [
      { "tool": "Bash", "command": "rm -rf /" },
      { "tool": "Bash", "command": "sudo *" }
    ],
    "defaultMode": "ask"
  },
  "env": {
    "NODE_ENV": "development"
  }
}
```

### MCP 服务器配置

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  },
  "allowedMcpServers": [
    { "serverName": "filesystem" },
    { "serverName": "github" }
  ]
}
```

### Hooks 配置

```json
{
  "hooks": {
    "FileChanged": [
      {
        "matcher": "*.test.ts",
        "command": "npm test -- ${file}"
      }
    ],
    "WorktreeCreate": [
      {
        "command": "git worktree add ../claude-worktree-${name} -b ${name}"
      }
    ]
  }
}
```

### 企业策略配置

```json
{
  "permissions": {
    "defaultMode": "auto",
    "allow": [
      { "tool": "Bash", "command": "npm *" },
      { "tool": "Bash", "command": "yarn *" }
    ]
  },
  "onlyManagedPermissionRules": true,
  "onlyManagedMcpServers": true,
  "deniedMcpServers": [
    { "serverName": "unsafe-server" }
  ],
  "env": {
    "CI": "true"
  }
}
```

### 本地私有配置 (local-settings.json)

```json
{
  "permissions": {
    "defaultMode": "auto"
  },
  "env": {
    "MY_SECRET_API_KEY": "sk-xxx",
    "PRIVATE_TOKEN": "token-xxx"
  }
}
```

---

## 配置加载流程

```
启动 Claude Code:
  ├─ 1. 加载 ~/.claude.json（全局状态）
  ├─ 2. 加载 ~/.claude/settings.json（用户设置）
  ├─ 3. 检测项目根目录
  ├─ 4. 加载 ./.claude/settings.json（项目设置）
  ├─ 5. 加载 ./.claude/local-settings.json（本地设置）
  ├─ 6. 加载 --settings 指定的文件（CLI标志）
  ├─ 7. 加载 managed-settings.json（企业策略）
  │     └─ 合并 managed-settings.d/*.json
  ├─ 8. 加载远程策略（如启用）
  └─ 9. 合并所有配置（后加载覆盖先加载）
```

---

## 相关文档

- [设置系统架构](../src/utils/settings/settings.ts)
- [配置类型定义](../src/utils/config.ts)
- [环境变量工具](../src/utils/envUtils.ts)
- [模型 Provider 配置](../src/utils/model/providers.ts)
