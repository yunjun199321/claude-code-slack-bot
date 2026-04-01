import { WorkingDirectoryConfig } from './types';
import { Logger } from './logger';
import { config } from './config';
import * as path from 'path';
import * as fs from 'fs';

export class WorkingDirectoryManager {
  private configs: Map<string, WorkingDirectoryConfig> = new Map();
  private logger = new Logger('WorkingDirectoryManager');
  private cleanupTimer: ReturnType<typeof setInterval>;
  private persistPath: string;

  constructor() {
    this.persistPath = process.env.WORKING_DIR_PERSIST_PATH
      || path.join(process.cwd(), 'data', 'working-dirs.json');
    this.loadFromDisk();
    // Clean up stale entries every 10 minutes
    this.cleanupTimer = setInterval(() => this.cleanupStaleConfigs(), 10 * 60 * 1000);
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8'));
      let loaded = 0;
      for (const [key, c] of Object.entries(raw) as [string, any][]) {
        if (!fs.existsSync(c.directory)) continue; // skip if dir no longer exists
        this.configs.set(key, {
          channelId: c.channelId,
          threadTs: c.threadTs,
          userId: c.userId,
          directory: c.directory,
          setAt: new Date(c.setAt),
          lastAccessed: new Date(c.lastAccessed),
        });
        loaded++;
      }
      this.logger.info('Working directory configs restored', { path: this.persistPath, count: loaded });
    } catch (error) {
      this.logger.warn('Failed to load working directory configs from disk', error);
    }
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data: Record<string, WorkingDirectoryConfig> = {};
      for (const [key, cfg] of this.configs.entries()) data[key] = cfg;
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      this.logger.warn('Failed to save working directory configs to disk', error);
    }
  }

  /**
   * Remove working directory configs that haven't been accessed for over 1 hour.
   * Channel-level (non-thread) configs are kept longer (24 hours) since they serve as defaults.
   */
  cleanupStaleConfigs(threadMaxAge: number = 60 * 60 * 1000, channelMaxAge: number = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, cfg] of this.configs.entries()) {
      const maxAge = cfg.threadTs ? threadMaxAge : channelMaxAge;
      if (now - cfg.lastAccessed.getTime() > maxAge) {
        this.configs.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.saveToDisk();
      this.logger.info(`Cleaned up ${cleaned} stale working directory configs (remaining: ${this.configs.size})`);
    }
  }

  destroy() {
    clearInterval(this.cleanupTimer);
  }

  getConfigKey(channelId: string, threadTs?: string, userId?: string): string {
    if (threadTs) {
      return `${channelId}-${threadTs}`;
    }
    if (userId && channelId.startsWith('D')) { // Direct message
      return `${channelId}-${userId}`;
    }
    return channelId;
  }

  setWorkingDirectory(channelId: string, directory: string, threadTs?: string, userId?: string): { success: boolean; resolvedPath?: string; error?: string } {
    try {
      const resolvedPath = this.resolveDirectory(directory);
      
      if (!resolvedPath) {
        return { 
          success: false, 
          error: `Directory not found: "${directory}"${config.baseDirectory ? ` (checked in base directory: ${config.baseDirectory})` : ''}` 
        };
      }

      const stats = fs.statSync(resolvedPath);
      
      if (!stats.isDirectory()) {
        this.logger.warn('Path is not a directory', { directory: resolvedPath });
        return { success: false, error: 'Path is not a directory' };
      }

      const key = this.getConfigKey(channelId, threadTs, userId);
      const now = new Date();
      const workingDirConfig: WorkingDirectoryConfig = {
        channelId,
        threadTs,
        userId,
        directory: resolvedPath,
        setAt: now,
        lastAccessed: now,
      };

      this.configs.set(key, workingDirConfig);
      this.saveToDisk();
      this.logger.info('Working directory set', {
        key,
        directory: resolvedPath,
        originalInput: directory,
        isThread: !!threadTs,
        isDM: channelId.startsWith('D'),
      });

      return { success: true, resolvedPath };
    } catch (error) {
      this.logger.error('Failed to set working directory', error);
      return { success: false, error: 'Directory does not exist or is not accessible' };
    }
  }

  private resolveDirectory(directory: string): string | null {
    // If it's an absolute path, use it directly
    if (path.isAbsolute(directory)) {
      if (fs.existsSync(directory)) {
        return path.resolve(directory);
      }
      return null;
    }

    // If we have a base directory configured, try relative to base directory first
    if (config.baseDirectory) {
      const baseRelativePath = path.join(config.baseDirectory, directory);
      if (fs.existsSync(baseRelativePath)) {
        this.logger.debug('Found directory relative to base', { 
          input: directory,
          baseDirectory: config.baseDirectory,
          resolved: baseRelativePath 
        });
        return path.resolve(baseRelativePath);
      }
    }

    // Try relative to current working directory
    const cwdRelativePath = path.resolve(directory);
    if (fs.existsSync(cwdRelativePath)) {
      this.logger.debug('Found directory relative to cwd', { 
        input: directory,
        resolved: cwdRelativePath 
      });
      return cwdRelativePath;
    }

    return null;
  }

  getWorkingDirectory(channelId: string, threadTs?: string, userId?: string): string | undefined {
    // Priority: Thread > Channel/DM > Default
    if (threadTs) {
      const threadKey = this.getConfigKey(channelId, threadTs);
      const threadConfig = this.configs.get(threadKey);
      if (threadConfig) {
        threadConfig.lastAccessed = new Date();
        this.logger.debug('Using thread-specific working directory', {
          directory: threadConfig.directory,
          threadTs,
        });
        return threadConfig.directory;
      }
    }

    // Fall back to channel or DM config
    const channelKey = this.getConfigKey(channelId, undefined, userId);
    const channelConfig = this.configs.get(channelKey);
    if (channelConfig) {
      channelConfig.lastAccessed = new Date();
      this.logger.debug('Using channel/DM working directory', {
        directory: channelConfig.directory,
        channelId,
      });
      return channelConfig.directory;
    }

    // Only fall back to explicit DEFAULT_WORKING_DIRECTORY (never HOME)
    const defaultDir = process.env.DEFAULT_WORKING_DIRECTORY;
    if (defaultDir && fs.existsSync(defaultDir)) {
      this.logger.debug('Using default working directory', { directory: defaultDir, channelId, threadTs });
      return defaultDir;
    }

    this.logger.debug('No working directory configured', { channelId, threadTs });
    return undefined;
  }

  removeWorkingDirectory(channelId: string, threadTs?: string, userId?: string): boolean {
    const key = this.getConfigKey(channelId, threadTs, userId);
    const result = this.configs.delete(key);
    if (result) {
      this.saveToDisk();
      this.logger.info('Working directory removed', { key });
    }
    return result;
  }

  listConfigurations(): WorkingDirectoryConfig[] {
    return Array.from(this.configs.values());
  }

  parseSetCommand(text: string): string | null {
    const cwdMatch = text.match(/^cwd\s+(.+)$/i);
    if (cwdMatch) {
      return cwdMatch[1].trim();
    }

    const setMatch = text.match(/^set\s+(?:cwd|dir|directory|working[- ]?directory)\s+(.+)$/i);
    if (setMatch) {
      return setMatch[1].trim();
    }

    return null;
  }

  isGetCommand(text: string): boolean {
    return /^(get\s+)?(cwd|dir|directory|working[- ]?directory)(\?)?$/i.test(text.trim());
  }

  formatDirectoryMessage(directory: string | undefined, context: string): string {
    if (directory) {
      let message = `Current working directory for ${context}: \`${directory}\``;
      if (config.baseDirectory) {
        message += `\n\nBase directory: \`${config.baseDirectory}\``;
        message += `\nYou can use relative paths like \`cwd project-name\` or absolute paths.`;
      }
      return message;
    }
    
    let message = `No working directory set for ${context}. Please set one using:`;
    if (config.baseDirectory) {
      message += `\n\`cwd project-name\` (relative to base directory)`;
      message += `\n\`cwd /absolute/path/to/directory\` (absolute path)`;
      message += `\n\nBase directory: \`${config.baseDirectory}\``;
    } else {
      message += `\n\`cwd /path/to/directory\` or \`set directory /path/to/directory\``;
    }
    return message;
  }

  getChannelWorkingDirectory(channelId: string): string | undefined {
    const key = this.getConfigKey(channelId);
    const config = this.configs.get(key);
    return config?.directory;
  }

  hasChannelWorkingDirectory(channelId: string): boolean {
    return !!this.getChannelWorkingDirectory(channelId);
  }

  formatChannelSetupMessage(channelId: string, channelName: string): string {
    const hasBaseDir = !!config.baseDirectory;
    
    let message = `🏠 **Channel Working Directory Setup**\n\n`;
    message += `Please set the default working directory for #${channelName}:\n\n`;
    
    if (hasBaseDir) {
      message += `**Options:**\n`;
      message += `• \`cwd project-name\` (relative to: \`${config.baseDirectory}\`)\n`;
      message += `• \`cwd /absolute/path/to/project\` (absolute path)\n\n`;
    } else {
      message += `**Usage:**\n`;
      message += `• \`cwd /path/to/project\`\n`;
      message += `• \`set directory /path/to/project\`\n\n`;
    }
    
    message += `This becomes the default for all conversations in this channel.\n`;
    message += `Individual threads can override this by mentioning me with a different \`cwd\` command.`;
    
    return message;
  }
}