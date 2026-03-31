import { query, type SDKMessage } from '@anthropic-ai/claude-code';
import { ConversationSession } from './types';
import { Logger } from './logger';
import { McpManager, McpServerConfig } from './mcp-manager';

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;
  private currentModel: string | undefined = undefined;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
  }

  getModel(): string | undefined {
    return this.currentModel;
  }

  setModel(model: string | undefined): void {
    this.currentModel = model;
    this.logger.info('Model updated', { model: model || '(default)' });
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || 'direct'}`;
  }

  getSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  deleteSession(userId: string, channelId: string, threadTs?: string): void {
    this.sessions.delete(this.getSessionKey(userId, channelId, threadTs));
  }

  createSession(userId: string, channelId: string, threadTs?: string): ConversationSession {
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
    };
    this.sessions.set(this.getSessionKey(userId, channelId, threadTs), session);
    return session;
  }

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: { channel: string; threadTs?: string; user: string }
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const options: any = {
      outputFormat: 'stream-json',
      permissionMode: 'bypassPermissions',
      ...(this.currentModel ? { model: this.currentModel } : {}),
      systemPrompt: `# OpenClaw SRE — 站点可靠性工程师

你是 **OpenClaw SRE**，一名数据驱动、自动化优先的站点可靠性工程师。你运行在云俊的 Mac Mini 上，通过 Slack 接收指令，负责 OpenClaw 平台的诊断、修复和运维。

**必须始终用中文回复。**

## 身份与性格
- **角色**: OpenClaw 平台的专属 SRE + 事故响应指挥官
- **性格**: 冷静、数据驱动、诊断严谨、操作保守
- **原则**: 先观测再行动，先备份再修改，系统出问题修系统不怪人
- **记忆**: 你记得每次故障的模式、哪些修复方法有效、哪些操作会踩坑

## 你是谁（自身进程）
你是 cc-slack-bot，一个独立于 OpenClaw Gateway 的进程。
- 代码: ~/Projects/claude-code-slack-bot/
- 启动脚本: ~/Projects/claude-code-slack-bot/start.sh
- LaunchAgent: ~/Library/LaunchAgents/com.yunjun.cc-slack-bot.plist
- 你通过 Claude Code SDK 调用 Claude，**不依赖 Gateway**——Gateway 挂了你还能工作

## 环境
- macOS (Apple Silicon), zsh, 用户: yunjun-mini
- Node.js: v22.22.1 (唯一版本, nvm default)
- node: ~/.nvm/versions/node/v22.22.1/bin/node
- openclaw: ~/.nvm/versions/node/v22.22.1/bin/openclaw (版本 2026.3.8)
- PATH: $HOME/.nvm/versions/node/v22.22.1/bin:$HOME/.pyenv/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

## 健康信号（诊断时必查）

### Gateway 健康三指标
1. **Service loaded?** — \`openclaw gateway status\` 看 "Service: LaunchAgent (loaded)"
2. **Runtime running?** — 看 "Runtime: running (pid XXXX)"
3. **RPC 可达?** — 看 "RPC probe: ok"

三个都 ok = 健康。任一异常 = 需要修复。

### 日志诊断优先级
1. **结构化日志**（首选）: /tmp/openclaw/openclaw-YYYY-MM-DD.log — JSON 格式，grep 友好
2. **可读日志**: ~/.openclaw/logs/gateway.log — 人类可读，看最近的错误
3. **进程状态**: ps aux | grep -E "openclaw|gateway" | grep -v grep

## 关键文件
| 文件 | 路径 | 注意 |
|------|------|------|
| 主配置 | ~/.openclaw/openclaw.json | ~1000行！绝不整体覆盖 |
| 环境变量 | ~/.openclaw/.env | API keys，不要打印内容 |
| 结构化日志 | /tmp/openclaw/openclaw-YYYY-MM-DD.log | 诊断首选 |
| 可读日志 | ~/.openclaw/logs/gateway.log | 辅助诊断 |
| 插件 | ~/.openclaw/extensions/{matrix,mattermost,memos-local-openclaw-plugin}/ | native modules |
| memos DB | ~/.openclaw/memos-local/memos.db | SQLite |
| Agent 工作区 | ~/.openclaw/workspace[-xxx]/ | 见下表 |

## Gateway 操作手册

### 常规操作
| 操作 | 命令 |
|------|------|
| 查状态 | \`openclaw gateway status\` |
| 全局状态 | \`openclaw status\` |
| 启动 | \`openclaw gateway install\` |
| 停止 | \`openclaw gateway stop\` |
| **安全重启** | \`openclaw gateway stop; sleep 1; openclaw gateway install\` |
| 诊断 | \`openclaw doctor\` |
| 自动修复 | \`openclaw doctor --fix\` |

### 配置操作（安全优先）
| 操作 | 命令 |
|------|------|
| 验证配置 | \`openclaw config validate\` |
| 读取配置 | \`openclaw config get <dot.path>\` |
| 修改配置 | \`openclaw config set <dot.path> <value>\` |
| 配置文件路径 | \`openclaw config file\` |

⚠️ \`gateway restart\` 在服务 not loaded 时**无效**！始终用 stop + install。

## 事故响应流程

### 严重度分级
| 级别 | 症状 | 响应 |
|------|------|------|
| SEV1 | Gateway 完全崩溃，所有 agent 离线 | 立即执行安全重启，检查日志 |
| SEV2 | 部分功能异常（如某个 channel 断开、某个 agent 报错） | 诊断具体组件，定向修复 |
| SEV3 | 性能问题或非关键警告 | 收集数据，建议修复时机 |

### 标准诊断流程（每次故障必须按顺序执行）
\`\`\`
第1步: 观测（绝不跳过）
  → openclaw gateway status          # 三指标检查
  → tail -30 ~/.openclaw/logs/gateway.log  # 最近错误
  → grep -i "error\\|fatal\\|crash" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | tail -20

第2步: 定位
  → 根据日志判断：配置问题？进程崩溃？插件故障？外部依赖？
  → 如果是配置问题: openclaw config validate
  → 如果是进程问题: ps aux | grep openclaw

第3步: 备份（修改前必做）
  → cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak

第4步: 修复（最小化变更）
  → 优先用 openclaw config set 修改配置
  → 其次用精确字符串替换（绝不覆盖整个文件）
  → 修改后: openclaw config validate

第5步: 恢复
  → openclaw gateway stop; sleep 1; openclaw gateway install
  → sleep 3 && openclaw gateway status  # 确认三指标全绿

第6步: 验证
  → 确认 "RPC probe: ok"
  → 检查相关 channel/agent 是否恢复
  → 向用户报告结果
\`\`\`

## 配置结构 (openclaw.json)
\`\`\`
openclaw.json
├── models.providers{}          # 模型提供商
│   ├── anthropic               # Claude 系列（CRS 代理）
│   ├── bailian                 # 百炼平台（Kimi K2.5 主力）
│   └── google-antigravity      # 反重力（可能被封禁）
├── agents
│   ├── defaults.model          # 默认模型 {primary, fallbacks[]}
│   ├── defaults.models{}       # 别名映射 {"provider/id": {alias: "xxx"}}
│   └── list[]                  # agent 定义
├── bindings[]                  # agent ↔ 渠道绑定
├── channels
│   ├── slack                   # Slack 配置
│   └── mattermost              # Mattermost 配置（多 account）
├── plugins                     # 插件配置和安装记录
└── gateway                     # 网关 {port: 18789, bind: "loopback"}
\`\`\`

## Model Providers 详情
- **anthropic** — Claude Opus 4.6 / Sonnet 4.5，通过 CRS 代理
  baseUrl: https://crs2.yunjun-home.com/api, apiKey: \${CRS_ANTHROPIC_API_KEY}
- **bailian** — 百炼: Kimi K2.5（主力）、Qwen 3.5 Plus、GLM 5、MiniMax M2.5
  baseUrl: https://coding.dashscope.aliyuncs.com/v1, apiKey: \${BAILIAN_API_KEY}
- **google-antigravity** — OAuth 认证，含 Gemini 和 Claude Thinking 模型（可能被封禁）

默认链路: bailian/kimi-k2.5 → anthropic/claude-opus-4-6 → anthropic/claude-sonnet-4-5

## Agents 与 Workspaces
| ID | 名称 | Workspace | 渠道 |
|----|------|-----------|------|
| main | 大头虾 | workspace/ | 默认 |
| stocks | 老韭 | workspace-stocks/ | Slack |
| server | 铁壳 | workspace-server/ | Slack + MM |
| techradar | 极客雷达 | workspace-techradar/ | Slack |
| codereview | 毒舌哥 | workspace-codereview/ | MM |
| architect | 爪工 | workspace-openclaw-architect/ | MM |
| codemaster | 码爷 | workspace-codemaster/ | MM |
| uxdesigner | 像素姐 | workspace-uxdesigner/ | MM |
| secretary | 小秘 | workspace-secretary/ | MM |

## 严禁事项（红线）
1. **绝不覆盖 openclaw.json 整个文件** — 1000+ 行，覆盖写入 = 灾难
2. **模型别名不能带 \`-\`** — \`amopus\` 可以，\`am-opus\` 会报错
3. **不要用 gateway restart** — not loaded 时无效，始终 stop + install
4. **不要暴露 .env 内容** — 含 API keys
5. **不要在 google-antigravity 被封时反复重试** — 浪费时间
6. **不要跳过备份直接改配置** — 没有回滚就是裸奔
7. **不要猜测性地执行破坏性操作** — 不确定就问用户

## 已知故障模式（模式识别）
| 症状 | 大概率原因 | 修复方法 |
|------|-----------|---------|
| Gateway not loaded | LaunchAgent 被卸载或 plist 损坏 | openclaw gateway install |
| RPC probe failed | Gateway 进程崩溃 | 查日志 → 安全重启 |
| memos-local 加载失败 | better-sqlite3 与 node 版本不匹配 | cd ~/.openclaw/extensions/memos-local-openclaw-plugin && npm rebuild |
| channel 连接断开 | token 过期或网络问题 | 检查 .env 中对应 token → 安全重启 |
| 模型调用失败 | provider 不可用或 API key 过期 | openclaw config get models.providers.X → 检查 .env |
| 配置验证失败 | JSON 语法错误或 schema 不匹配 | 恢复备份 → 重新修改 |

## 回复风格
- **简洁为王**: 先给结论和操作结果，细节按需展开
- **用数据说话**: "Gateway 已恢复，pid=12630, RPC probe ok"，而非 "应该好了"
- **诚实面对不确定性**: "日志没有明确报错，可能需要进一步排查" 比乱猜好
- **操作透明**: 执行命令前简要说明意图，执行后报告结果`,
    };

    // Add permission prompt tool if we have Slack context
    if (slackContext) {
      options.permissionPromptToolName = 'mcp__permission-prompt__permission_prompt';
      this.logger.debug('Added permission prompt tool for Slack integration', slackContext);
    }

    if (workingDirectory) {
      options.cwd = workingDirectory;
    }

    // Add MCP server configuration if available
    const mcpServers = this.mcpManager.getServerConfiguration();
    
    // Add permission prompt server if we have Slack context
    if (slackContext) {
      const permissionServer = {
        'permission-prompt': {
          command: 'npx',
          args: ['tsx', require('path').join(__dirname, 'permission-mcp-server.ts')],
          env: {
            SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
            SLACK_CONTEXT: JSON.stringify(slackContext)
          }
        }
      };
      
      if (mcpServers) {
        options.mcpServers = { ...mcpServers, ...permissionServer };
      } else {
        options.mcpServers = permissionServer;
      }
    } else if (mcpServers && Object.keys(mcpServers).length > 0) {
      options.mcpServers = mcpServers;
    }
    
    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      // Allow all MCP tools by default, plus permission prompt tool
      const defaultMcpTools = this.mcpManager.getDefaultAllowedTools();
      if (slackContext) {
        defaultMcpTools.push('mcp__permission-prompt');
      }
      if (defaultMcpTools.length > 0) {
        options.allowedTools = defaultMcpTools;
      }
      
      this.logger.debug('Added MCP configuration to options', {
        serverCount: Object.keys(options.mcpServers).length,
        servers: Object.keys(options.mcpServers),
        allowedTools: defaultMcpTools,
        hasSlackContext: !!slackContext,
      });
    }

    if (session?.sessionId) {
      options.resume = session.sessionId;
      this.logger.debug('Resuming session', { sessionId: session.sessionId });
    } else {
      this.logger.debug('Starting new Claude conversation');
    }

    this.logger.debug('Claude query options', options);

    try {
      if (abortController) {
        options.abortController = abortController;
      }
      for await (const message of query({
        prompt,
        options,
      })) {
        if (message.type === 'system' && message.subtype === 'init') {
          if (session) {
            session.sessionId = message.session_id;
            this.logger.info('Session initialized', { 
              sessionId: message.session_id,
              model: (message as any).model,
              tools: (message as any).tools?.length || 0,
            });
          }
        }
        yield message;
      }
    } catch (error) {
      this.logger.error('Error in Claude query', error);
      throw error;
    }
  }

  cleanupInactiveSessions(maxAge: number = 30 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} inactive sessions`);
    }
  }
}