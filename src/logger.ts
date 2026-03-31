import { config } from './config';

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  private formatMessage(level: string, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level}] [${this.context}]`;

    if (data) {
      try {
        return `${prefix} ${message}\n${JSON.stringify(data, null, 2)}`;
      } catch {
        // Handle circular references or non-serializable data
        return `${prefix} ${message}\n[unserializable data]`;
      }
    }
    return `${prefix} ${message}`;
  }

  debug(message: string, data?: any) {
    if (config.debug) {
      console.log(this.formatMessage('DEBUG', message, data));
    }
  }

  info(message: string, data?: any) {
    console.log(this.formatMessage('INFO', message, data));
  }

  warn(message: string, data?: any) {
    console.warn(this.formatMessage('WARN', message, data));
  }

  error(message: string, error?: any) {
    const errorData = error instanceof Error ? {
      errorMessage: error.message,
      stack: error.stack,
      ...error
    } : error;
    console.error(this.formatMessage('ERROR', message, errorData));
  }

  /**
   * Structured audit log entry (JSON line format).
   * Use for security-relevant events: commands, permission decisions, session lifecycle.
   */
  audit(event: string, data: Record<string, unknown>) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'AUDIT',
      context: this.context,
      event,
      ...data,
    }));
  }
}