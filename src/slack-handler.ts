import { App } from '@slack/bolt';
import { ClaudeHandler } from './claude-handler';
import { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Logger } from './logger';
import { WorkingDirectoryManager } from './working-directory-manager';
import { FileHandler, ProcessedFile } from './file-handler';
import { TodoManager, Todo } from './todo-manager';
import { McpManager } from './mcp-manager';
import { writeApprovalResult, cleanupStaleApprovals } from './permission-bridge';
import { config } from './config';
import { RateLimiter } from './rate-limiter';
import { loadBotConfig, formatWelcomeMessage } from './bot-config';

interface MessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    filetype: string;
    url_private: string;
    url_private_download: string;
    size: number;
  }>;
}

export class SlackHandler {
  private app: App;
  private claudeHandler: ClaudeHandler;
  private activeControllers: Map<string, AbortController> = new Map();
  private logger = new Logger('SlackHandler');
  private workingDirManager: WorkingDirectoryManager;
  private fileHandler: FileHandler;
  private todoManager: TodoManager;
  private mcpManager: McpManager;
  private todoMessages: Map<string, string> = new Map(); // sessionKey -> messageTs
  private originalMessages: Map<string, { channel: string; ts: string }> = new Map(); // sessionKey -> original message info
  private currentReactions: Map<string, string> = new Map(); // sessionKey -> current emoji
  private botUserId: string | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private rateLimiter: RateLimiter;

  constructor(app: App, claudeHandler: ClaudeHandler, mcpManager: McpManager) {
    this.app = app;
    this.claudeHandler = claudeHandler;
    this.mcpManager = mcpManager;
    this.workingDirManager = new WorkingDirectoryManager();
    this.fileHandler = new FileHandler();
    this.todoManager = new TodoManager();
    const rateLimit = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '10', 10);
    this.rateLimiter = new RateLimiter(rateLimit, 60 * 1000);
  }

  async handleMessage(event: MessageEvent, say: any) {
    const { user, channel, thread_ts, ts, files } = event;
    let text = event.text;
    const isDM = channel.startsWith('D');
    const replyThreadTs = isDM ? undefined : (thread_ts || ts);
    const sessionThreadTs = isDM ? undefined : (thread_ts || ts);
    const replyOpts = replyThreadTs ? { thread_ts: replyThreadTs } : {};

    // Phase 1: Rate limiting
    if (!this.rateLimiter.isAllowed(user)) {
      await say({ text: `⚠️ Rate limit exceeded. (${process.env.RATE_LIMIT_PER_MINUTE || '10'}/min)`, ...replyOpts });
      return;
    }
    if (!text && (!files || files.length === 0)) return;

    this.logger.debug('Received message', { user, channel, text: text?.substring(0, 100), fileCount: files?.length || 0 });

    // Phase 2: Command parsing (returns early if handled)
    const commandResult = await this.handleCommand(text, user, channel, isDM, thread_ts, sessionThreadTs, replyOpts, say);
    if (commandResult.handled) {
      text = commandResult.expandedText || text;
      if (commandResult.returned) return;
    }

    // Phase 3: Context validation
    const workingDirectory = this.workingDirManager.getWorkingDirectory(channel, thread_ts, isDM ? user : undefined);
    if (!workingDirectory) {
      await say({ text: this.buildMissingDirMessage(isDM, channel, thread_ts), ...replyOpts });
      return;
    }

    // Phase 4: File processing (after commands to avoid temp file leaks)
    let processedFiles: ProcessedFile[] = [];
    if (files && files.length > 0) {
      this.logger.info('Processing uploaded files', { count: files.length });
      processedFiles = await this.fileHandler.downloadAndProcessFiles(files);
      if (processedFiles.length > 0) {
        await say({ text: `📎 Processing ${processedFiles.length} file(s): ${processedFiles.map(f => f.name).join(', ')}`, ...replyOpts });
      }
    }

    // Phase 5: Execute Claude query
    await this.executeClaudeQuery(text, user, channel, thread_ts, ts, isDM, sessionThreadTs, replyThreadTs, replyOpts, processedFiles, workingDirectory, say);
  }

  /**
   * Phase 2: Parse and handle local commands. Returns { handled, returned, expandedText }.
   * - handled=true, returned=true: command fully handled, caller should return
   * - handled=true, returned=false: shortcut expanded, caller should continue with expandedText
   * - handled=false: not a command, pass through
   */
  private async handleCommand(
    text: string | undefined, user: string, channel: string, isDM: boolean,
    thread_ts: string | undefined, sessionThreadTs: string | undefined,
    replyOpts: any, say: any,
  ): Promise<{ handled: boolean; returned: boolean; expandedText?: string }> {
    if (!text) return { handled: false, returned: false };

    const isAdmin = config.adminUsers.length > 0 ? config.adminUsers.includes(user) : false;

    // !model
    if (/^[!/]model(\s+\S+)?$/.test(text.trim())) {
      const parts = text.trim().split(/\s+/);
      if (parts.length === 1) {
        const current = this.claudeHandler.getModel();
        await say({ text: `🤖 *Current model:* \`${current || '(SDK default)'}\`\n\n\`!model <name>\` to switch, \`!model default\` to reset`, ...replyOpts });
      } else {
        if (!isAdmin) { await say({ text: '⛔ Admin only.', ...replyOpts }); return { handled: true, returned: true }; }
        const m = parts[1];
        this.claudeHandler.setModel(m === 'default' ? undefined : m);
        await say({ text: m === 'default' ? `✅ Model reset to SDK default` : `✅ Model: \`${m}\``, ...replyOpts });
      }
      return { handled: true, returned: true };
    }

    const trimmed = text.trim().toLowerCase();

    // !new
    if (trimmed === '/new' || trimmed === '!new') {
      const key = this.claudeHandler.getSessionKey(user, channel, sessionThreadTs);
      this.logger.audit('session.reset', { user, channel, sessionKey: key });
      this.claudeHandler.deleteSession(user, channel, sessionThreadTs);
      await say({ text: `🔄 *Session reset.* Ready for new conversation.`, ...replyOpts });
      return { handled: true, returned: true };
    }

    // !quit (admin only)
    if (trimmed === '/quit' || trimmed === '!quit') {
      if (!isAdmin) { await say({ text: '⛔ Admin only.', ...replyOpts }); return { handled: true, returned: true }; }
      this.logger.audit('command.quit', { user, channel });
      await say({ text: `👋 *Shutting down...*`, ...replyOpts });
      try { require('child_process').execSync('tmux kill-session', { stdio: 'ignore' }); } catch { process.exit(0); }
      return { handled: true, returned: true };
    }

    // !context
    if (trimmed === '!context' || trimmed === '/context') {
      const session = this.claudeHandler.getSession(user, channel, sessionThreadTs);
      const dir = this.workingDirManager.getWorkingDirectory(channel, thread_ts, isDM ? user : undefined);
      const model = this.claudeHandler.getModel();
      await say({
        text: `📋 *Current context:*\n` +
          `• Working directory: \`${dir || '(not set)'}\`\n` +
          `• Model: \`${model || '(SDK default)'}\`\n` +
          `• Session: ${session?.sessionId ? `active (\`${session.sessionId.substring(0, 8)}...\`)` : 'none'}\n` +
          `• Admin: ${isAdmin ? 'yes' : 'no'}`,
        ...replyOpts,
      });
      return { handled: true, returned: true };
    }

    // !reset-dir
    if (trimmed === '!reset-dir' || trimmed === '/reset-dir') {
      this.workingDirManager.removeWorkingDirectory(channel, thread_ts, isDM ? user : undefined);
      await say({ text: `✅ Working directory binding cleared.`, ...replyOpts });
      return { handled: true, returned: true };
    }

    // Shortcuts (! or / prefix)
    if (text.startsWith('!') || text.startsWith('/')) {
      const shortcut = text.slice(1).trim().toLowerCase();
      const botCfg = loadBotConfig();
      const shortcuts: Record<string, string> = { ...botCfg.shortcuts, 'help': '' };

      if (shortcut === 'help') {
        const helpText = Object.entries(shortcuts)
          .filter(([k]) => k !== 'help')
          .map(([k, v]) => `\`!${k}\` — ${v.substring(0, 60)}`)
          .join('\n');
        await say({
          text: `📋 *Commands:*\n${helpText}\n\`!model\` — Show/switch model\n\`!context\` — Show current context\n\`!new\` — Reset session\n\`!reset-dir\` — Clear directory binding\n\`!quit\` — Shutdown (admin)\n\`!help\` — This help`,
          ...replyOpts,
        });
        return { handled: true, returned: true };
      }

      if (shortcuts[shortcut]) {
        this.logger.audit('command.executed', { user, channel, command: shortcut });
        return { handled: true, returned: false, expandedText: shortcuts[shortcut] };
      }
    }

    // cwd set
    const setDirPath = this.workingDirManager.parseSetCommand(text);
    if (setDirPath) {
      const result = this.workingDirManager.setWorkingDirectory(channel, setDirPath, thread_ts, isDM ? user : undefined);
      const ctx = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
      await say({ text: result.success ? `✅ Working directory set for ${ctx}: \`${result.resolvedPath}\`` : `❌ ${result.error}`, ...replyOpts });
      return { handled: true, returned: true };
    }

    // cwd get
    if (this.workingDirManager.isGetCommand(text)) {
      const dir = this.workingDirManager.getWorkingDirectory(channel, thread_ts, isDM ? user : undefined);
      const ctx = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
      await say({ text: this.workingDirManager.formatDirectoryMessage(dir, ctx), ...replyOpts });
      return { handled: true, returned: true };
    }

    // MCP info/reload
    if (this.isMcpInfoCommand(text)) {
      await say({ text: this.mcpManager.formatMcpInfo(), ...replyOpts });
      return { handled: true, returned: true };
    }
    if (this.isMcpReloadCommand(text)) {
      const ok = this.mcpManager.reloadConfiguration();
      await say({ text: ok ? `✅ MCP reloaded.\n\n${this.mcpManager.formatMcpInfo()}` : `❌ MCP reload failed.`, ...replyOpts });
      return { handled: true, returned: true };
    }

    return { handled: false, returned: false };
  }

  private buildMissingDirMessage(isDM: boolean, channel: string, thread_ts?: string): string {
    let msg = `⚠️ No working directory set. `;
    if (!isDM && !this.workingDirManager.hasChannelWorkingDirectory(channel)) {
      msg += `Set one with:\n`;
      msg += config.baseDirectory ? `\`cwd project-name\` or \`cwd /absolute/path\`\n\nBase: \`${config.baseDirectory}\`` : `\`cwd /path/to/directory\``;
    } else if (thread_ts) {
      msg += `Set a thread-specific directory:\n`;
      msg += config.baseDirectory ? `\`cwd project-name\` or \`cwd /absolute/path\`` : `\`cwd /path/to/directory\``;
    } else {
      msg += `Set one with:\n\`cwd /path/to/directory\``;
    }
    return msg;
  }

  /**
   * Phase 5: Execute Claude query with streaming, tool handling, and cleanup.
   */
  private async executeClaudeQuery(
    text: string | undefined, user: string, channel: string,
    thread_ts: string | undefined, ts: string, isDM: boolean,
    sessionThreadTs: string | undefined, replyThreadTs: string | undefined,
    replyOpts: any, processedFiles: ProcessedFile[],
    workingDirectory: string, say: any,
  ) {
    const sessionKey = this.claudeHandler.getSessionKey(user, channel, sessionThreadTs);
    this.originalMessages.set(sessionKey, { channel, ts: replyThreadTs || ts });

    // Cancel any existing request
    const existingController = this.activeControllers.get(sessionKey);
    if (existingController) {
      this.logger.debug('Cancelling existing request', { sessionKey });
      existingController.abort();
    }

    const abortController = new AbortController();
    this.activeControllers.set(sessionKey, abortController);

    let session = this.claudeHandler.getSession(user, channel, sessionThreadTs);
    let isNewSession = false;
    if (!session) {
      session = this.claudeHandler.createSession(user, channel, sessionThreadTs);
      isNewSession = true;
    }

    if (isNewSession) {
      await say({ text: formatWelcomeMessage(workingDirectory), ...replyOpts });
    }

    let currentMessages: string[] = [];
    let statusMessageTs: string | undefined;

    try {
      const finalPrompt = processedFiles.length > 0
        ? await this.fileHandler.formatFilePrompt(processedFiles, text || '')
        : text || '';

      this.logger.info('Sending query to Claude', {
        promptLength: finalPrompt.length,
        sessionId: session.sessionId, workingDirectory, fileCount: processedFiles.length,
      });

      const statusResult = await say({ text: '🤔 *Thinking...*', ...replyOpts });
      statusMessageTs = statusResult.ts;
      await this.updateMessageReaction(sessionKey, 'thinking_face');

      const slackContext = { channel, threadTs: thread_ts, user };

      for await (const message of this.claudeHandler.streamQuery(finalPrompt, session, abortController, workingDirectory, slackContext)) {
        if (abortController.signal.aborted) break;

        if (message.type === 'assistant') {
          const hasToolUse = message.message.content?.some((part: any) => part.type === 'tool_use');

          if (hasToolUse) {
            if (statusMessageTs) {
              await this.app.client.chat.update({ channel, ts: statusMessageTs, text: '⚙️ *Working...*' });
            }
            await this.updateMessageReaction(sessionKey, 'gear');

            const todoTool = message.message.content?.find((part: any) => part.type === 'tool_use' && part.name === 'TodoWrite');
            if (todoTool) {
              await this.handleTodoUpdate((todoTool as any).input, sessionKey, session?.sessionId, channel, replyThreadTs || ts, say);
            }

            const toolContent = this.formatToolUse(message.message.content);
            if (toolContent) {
              await say({ text: toolContent, ...replyOpts });
            }
          } else {
            const content = this.extractTextContent(message);
            if (content) {
              currentMessages.push(content);
              for (const chunk of this.splitMessage(this.formatMessage(content, false))) {
                await say({ text: chunk, ...replyOpts });
              }
            }
          }
        } else if (message.type === 'result') {
          this.logger.info('Result received', {
            subtype: message.subtype, totalCost: (message as any).total_cost_usd, duration: (message as any).duration_ms,
          });
          if (message.subtype === 'success' && (message as any).result) {
            const finalResult = (message as any).result;
            if (finalResult && !currentMessages.includes(finalResult)) {
              for (const chunk of this.splitMessage(this.formatMessage(finalResult, true))) {
                await say({ text: chunk, ...replyOpts });
              }
            }
          }
        }
      }

      if (statusMessageTs) {
        await this.app.client.chat.update({ channel, ts: statusMessageTs, text: '✅ *Task completed*' });
      }
      await this.updateMessageReaction(sessionKey, 'white_check_mark');
      this.logger.info('Completed', { sessionKey, messageCount: currentMessages.length });

      if (processedFiles.length > 0) await this.fileHandler.cleanupTempFiles(processedFiles);
    } catch (error: any) {
      try {
        if (error.name !== 'AbortError') {
          this.logger.error('Error handling message', error);
          if (statusMessageTs) await this.app.client.chat.update({ channel, ts: statusMessageTs, text: '❌ *Error occurred*' });
          await this.updateMessageReaction(sessionKey, 'x');
          await say({ text: `Error: ${error.message || 'Something went wrong'}`, ...replyOpts });
        } else {
          this.logger.debug('Request aborted', { sessionKey });
          if (statusMessageTs) await this.app.client.chat.update({ channel, ts: statusMessageTs, text: '⏹️ *Cancelled*' });
          await this.updateMessageReaction(sessionKey, 'stop_button');
        }
      } catch (cleanupError) {
        this.logger.error('Error during cleanup', cleanupError);
      }
      if (processedFiles.length > 0) await this.fileHandler.cleanupTempFiles(processedFiles);
    } finally {
      this.activeControllers.delete(sessionKey);
      if (session?.sessionId) {
        setTimeout(() => {
          this.todoManager.cleanupSession(session.sessionId!);
          this.todoMessages.delete(sessionKey);
          this.originalMessages.delete(sessionKey);
          this.currentReactions.delete(sessionKey);
        }, 5 * 60 * 1000);
      }
    }
  }

  private extractTextContent(message: SDKMessage): string | null {
    if (message.type === 'assistant' && message.message.content) {
      const textParts = message.message.content
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text);
      return textParts.join('');
    }
    return null;
  }

  private formatToolUse(content: any[]): string {
    const parts: string[] = [];
    
    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part.text);
      } else if (part.type === 'tool_use') {
        const toolName = part.name;
        const input = part.input;
        
        switch (toolName) {
          case 'Edit':
          case 'MultiEdit':
            parts.push(this.formatEditTool(toolName, input));
            break;
          case 'Write':
            parts.push(this.formatWriteTool(input));
            break;
          case 'Read':
            parts.push(this.formatReadTool(input));
            break;
          case 'Bash':
            parts.push(this.formatBashTool(input));
            break;
          case 'TodoWrite':
            // Handle TodoWrite separately - don't include in regular tool output
            return this.handleTodoWrite(input);
          default:
            parts.push(this.formatGenericTool(toolName, input));
        }
      }
    }
    
    return parts.join('\n\n');
  }

  private formatEditTool(toolName: string, input: any): string {
    const filePath = input.file_path;
    const edits = toolName === 'MultiEdit' ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];
    
    let result = `📝 *Editing \`${filePath}\`*\n`;
    
    for (const edit of edits) {
      result += '\n```diff\n';
      result += `- ${this.truncateString(edit.old_string, 200)}\n`;
      result += `+ ${this.truncateString(edit.new_string, 200)}\n`;
      result += '```';
    }
    
    return result;
  }

  private formatWriteTool(input: any): string {
    const filePath = input.file_path;
    const preview = this.truncateString(input.content, 300);
    
    return `📄 *Creating \`${filePath}\`*\n\`\`\`\n${preview}\n\`\`\``;
  }

  private formatReadTool(input: any): string {
    return `👁️ *Reading \`${input.file_path}\`*`;
  }

  private formatBashTool(input: any): string {
    return `🖥️ *Running command:*\n\`\`\`bash\n${input.command}\n\`\`\``;
  }

  private formatGenericTool(toolName: string, input: any): string {
    return `🔧 *Using ${toolName}*`;
  }

  private truncateString(str: string, maxLength: number): string {
    if (!str) return '';
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
  }

  private handleTodoWrite(input: any): string {
    // TodoWrite tool doesn't produce visible output - handled separately
    return '';
  }

  private async handleTodoUpdate(
    input: any, 
    sessionKey: string, 
    sessionId: string | undefined, 
    channel: string, 
    threadTs: string, 
    say: any
  ): Promise<void> {
    if (!sessionId || !input.todos) {
      return;
    }

    const newTodos: Todo[] = input.todos;
    const oldTodos = this.todoManager.getTodos(sessionId);
    
    // Check if there's a significant change
    if (this.todoManager.hasSignificantChange(oldTodos, newTodos)) {
      // Update the todo manager
      this.todoManager.updateTodos(sessionId, newTodos);
      
      // Format the todo list
      const todoList = this.todoManager.formatTodoList(newTodos);
      
      // Check if we already have a todo message for this session
      const existingTodoMessageTs = this.todoMessages.get(sessionKey);
      
      if (existingTodoMessageTs) {
        // Update existing todo message
        try {
          await this.app.client.chat.update({
            channel,
            ts: existingTodoMessageTs,
            text: todoList,
          });
          this.logger.debug('Updated existing todo message', { sessionKey, messageTs: existingTodoMessageTs });
        } catch (error) {
          this.logger.warn('Failed to update todo message, creating new one', error);
          // If update fails, create a new message
          await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
        }
      } else {
        // Create new todo message
        await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
      }

      // Send status change notification if there are meaningful changes
      const statusChange = this.todoManager.getStatusChange(oldTodos, newTodos);
      if (statusChange) {
        await say({
          text: `🔄 *Task Update:*\n${statusChange}`,
          thread_ts: threadTs,
        });
      }

      // Update reaction based on overall progress
      await this.updateTaskProgressReaction(sessionKey, newTodos);
    }
  }

  private async createNewTodoMessage(
    todoList: string, 
    channel: string, 
    threadTs: string, 
    sessionKey: string, 
    say: any
  ): Promise<void> {
    const result = await say({
      text: todoList,
      thread_ts: threadTs,
    });
    
    if (result?.ts) {
      this.todoMessages.set(sessionKey, result.ts);
      this.logger.debug('Created new todo message', { sessionKey, messageTs: result.ts });
    }
  }

  private async updateMessageReaction(sessionKey: string, emoji: string): Promise<void> {
    const originalMessage = this.originalMessages.get(sessionKey);
    if (!originalMessage) {
      return;
    }

    // Check if we're already showing this emoji
    const currentEmoji = this.currentReactions.get(sessionKey);
    if (currentEmoji === emoji) {
      this.logger.debug('Reaction already set, skipping', { sessionKey, emoji });
      return;
    }

    try {
      // Remove the current reaction if it exists
      if (currentEmoji) {
        try {
          await this.app.client.reactions.remove({
            channel: originalMessage.channel,
            timestamp: originalMessage.ts,
            name: currentEmoji,
          });
          this.logger.debug('Removed previous reaction', { sessionKey, emoji: currentEmoji });
        } catch (error) {
          this.logger.debug('Failed to remove previous reaction (might not exist)', { 
            sessionKey, 
            emoji: currentEmoji,
            error: (error as any).message 
          });
        }
      }

      // Add the new reaction
      await this.app.client.reactions.add({
        channel: originalMessage.channel,
        timestamp: originalMessage.ts,
        name: emoji,
      });

      // Track the current reaction
      this.currentReactions.set(sessionKey, emoji);

      this.logger.debug('Updated message reaction', { 
        sessionKey, 
        emoji, 
        previousEmoji: currentEmoji,
        channel: originalMessage.channel, 
        ts: originalMessage.ts 
      });
    } catch (error) {
      this.logger.warn('Failed to update message reaction', error);
    }
  }

  private async updateTaskProgressReaction(sessionKey: string, todos: Todo[]): Promise<void> {
    if (todos.length === 0) {
      return;
    }

    const completed = todos.filter(t => t.status === 'completed').length;
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const total = todos.length;

    let emoji: string;
    if (completed === total) {
      emoji = 'white_check_mark';
    } else if (inProgress > 0) {
      emoji = 'arrows_counterclockwise';
    } else {
      emoji = 'clipboard';
    }

    await this.updateMessageReaction(sessionKey, emoji);
  }

  private isMcpInfoCommand(text: string): boolean {
    return /^(mcp|servers?)(\s+(info|list|status))?(\?)?$/i.test(text.trim());
  }

  private isMcpReloadCommand(text: string): boolean {
    return /^(mcp|servers?)\s+(reload|refresh)$/i.test(text.trim());
  }

  private async getBotUserId(): Promise<string> {
    if (!this.botUserId) {
      try {
        const response = await this.app.client.auth.test();
        this.botUserId = response.user_id as string;
      } catch (error) {
        this.logger.error('Failed to get bot user ID', error);
        this.botUserId = '';
      }
    }
    return this.botUserId;
  }

  private async handleChannelJoin(channelId: string, say: any): Promise<void> {
    try {
      // Get channel info
      const channelInfo = await this.app.client.conversations.info({
        channel: channelId,
      });

      const channelName = (channelInfo.channel as any)?.name || 'this channel';
      
      let welcomeMessage = `👋 Hi! I'm Claude Code, your AI coding assistant.\n\n`;
      welcomeMessage += `To get started, I need to know the default working directory for #${channelName}.\n\n`;
      
      if (config.baseDirectory) {
        welcomeMessage += `You can use:\n`;
        welcomeMessage += `• \`cwd project-name\` (relative to base directory: \`${config.baseDirectory}\`)\n`;
        welcomeMessage += `• \`cwd /absolute/path/to/project\` (absolute path)\n\n`;
      } else {
        welcomeMessage += `Please set it using:\n`;
        welcomeMessage += `• \`cwd /path/to/project\` or \`set directory /path/to/project\`\n\n`;
      }
      
      welcomeMessage += `This will be the default working directory for this channel. `;
      welcomeMessage += `You can always override it for specific threads by mentioning me with a different \`cwd\` command.\n\n`;
      welcomeMessage += `Once set, you can ask me to help with code reviews, file analysis, debugging, and more!`;

      await say({
        text: welcomeMessage,
      });

      this.logger.info('Sent welcome message to channel', { channelId, channelName });
    } catch (error) {
      this.logger.error('Failed to handle channel join', error);
    }
  }

  private formatMessage(text: string, isFinal: boolean): string {
    // Convert markdown code blocks to Slack format
    let formatted = text
      .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
        return '```' + code + '```';
      })
      .replace(/`([^`]+)`/g, '`$1`')
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      .replace(/__([^_]+)__/g, '_$1_');

    return formatted;
  }

  /**
   * Split a long message into chunks that fit Slack's 4000-char limit.
   * Splits at paragraph boundaries when possible to avoid breaking mid-sentence.
   */
  private splitMessage(text: string, maxLength: number = 3900): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLength) {
      // Try to split at a double newline (paragraph boundary)
      let splitIdx = remaining.lastIndexOf('\n\n', maxLength);
      // Fall back to single newline
      if (splitIdx <= 0) splitIdx = remaining.lastIndexOf('\n', maxLength);
      // Fall back to space
      if (splitIdx <= 0) splitIdx = remaining.lastIndexOf(' ', maxLength);
      // Last resort: hard split
      if (splitIdx <= 0) splitIdx = maxLength;

      chunks.push(remaining.substring(0, splitIdx));
      remaining = remaining.substring(splitIdx).trimStart();
    }
    if (remaining.length > 0) {
      chunks.push(remaining);
    }
    return chunks;
  }

  setupEventHandlers() {
    // Handle direct messages
    this.app.message(async ({ message, say }) => {
      if (message.subtype === undefined && 'user' in message) {
        this.logger.info('Handling direct message event');
        await this.handleMessage(message as MessageEvent, say);
      }
    });

    // Handle app mentions
    this.app.event('app_mention', async ({ event, say }) => {
      this.logger.info('Handling app mention event');
      const text = event.text.replace(/<@[^>]+>/g, '').trim();
      await this.handleMessage({
        ...event,
        text,
      } as MessageEvent, say);
    });

    // Handle file uploads in threads
    this.app.event('message', async ({ event, say }) => {
      // Only handle file uploads that are not from bots and have files
      if (event.subtype === 'file_share' && 'user' in event && event.files) {
        this.logger.info('Handling file upload event');
        await this.handleMessage(event as MessageEvent, say);
      }
    });

    // Handle bot being added to channels
    this.app.event('member_joined_channel', async ({ event, say }) => {
      // Check if the bot was added to the channel
      if (event.user === await this.getBotUserId()) {
        this.logger.info('Bot added to channel', { channel: event.channel });
        await this.handleChannelJoin(event.channel, say);
      }
    });

    // Handle permission approval button clicks
    this.app.action('approve_tool', async ({ ack, body, respond }) => {
      await ack();
      const approvalId = (body as any).actions[0].value;
      const approver = (body as any).user?.id || 'unknown';
      this.logger.audit('permission.approved', { approvalId, approver });

      writeApprovalResult(approvalId, true);

      await respond({
        response_type: 'ephemeral',
        text: '✅ Tool execution approved'
      });
    });

    // Handle permission denial button clicks
    this.app.action('deny_tool', async ({ ack, body, respond }) => {
      await ack();
      const approvalId = (body as any).actions[0].value;
      const denier = (body as any).user?.id || 'unknown';
      this.logger.audit('permission.denied', { approvalId, denier });

      writeApprovalResult(approvalId, false);

      await respond({
        response_type: 'ephemeral',
        text: '❌ Tool execution denied'
      });
    });

    // Cleanup inactive sessions periodically
    this.cleanupTimer = setInterval(() => {
      this.logger.debug('Running session cleanup');
      this.claudeHandler.cleanupInactiveSessions();
      cleanupStaleApprovals();
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  cancelAllActive(): void {
    for (const [key, controller] of this.activeControllers.entries()) {
      this.logger.info('Cancelling active session', { key });
      controller.abort();
    }
    this.activeControllers.clear();
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.workingDirManager.destroy();
    this.rateLimiter.destroy();
  }
}