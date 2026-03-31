import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';

const logger = new Logger('BotConfig');

export interface BotConfig {
  welcomeMessage: string;
  shortcuts: Record<string, string>;
}

const DEFAULT_CONFIG: BotConfig = {
  welcomeMessage: '🤖 *Claude Code Bot is ready*\nWorking directory: `{{workingDirectory}}`\n\n`!help` — Show commands\n`!model` — Show/switch model\n`!new` — Reset session\n\nDescribe what you need in natural language.',
  shortcuts: {},
};

let cachedConfig: BotConfig | null = null;

export function loadBotConfig(): BotConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = process.env.BOT_CONFIG_PATH
    || path.join(process.cwd(), 'bot-config.json');

  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      cachedConfig = {
        welcomeMessage: raw.welcomeMessage || DEFAULT_CONFIG.welcomeMessage,
        shortcuts: raw.shortcuts || DEFAULT_CONFIG.shortcuts,
      };
      logger.info('Bot config loaded', { path: configPath, shortcutCount: Object.keys(cachedConfig.shortcuts).length });
    } else {
      logger.info('No bot-config.json found, using defaults', { path: configPath });
      cachedConfig = DEFAULT_CONFIG;
    }
  } catch (error) {
    logger.error('Failed to load bot-config.json, using defaults', error);
    cachedConfig = DEFAULT_CONFIG;
  }

  return cachedConfig;
}

export function reloadBotConfig(): BotConfig {
  cachedConfig = null;
  return loadBotConfig();
}

export function formatWelcomeMessage(workingDirectory: string): string {
  const config = loadBotConfig();
  return config.welcomeMessage.replace(/\{\{workingDirectory\}\}/g, workingDirectory);
}
