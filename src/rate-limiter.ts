import { Logger } from './logger';

export class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private logger = new Logger('RateLimiter');
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private maxRequests: number = 10,
    private windowMs: number = 60 * 1000,
  ) {
    // Clean up old entries every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  isAllowed(userId: string): boolean {
    const now = Date.now();
    const timestamps = (this.requests.get(userId) || [])
      .filter(t => now - t < this.windowMs);

    if (timestamps.length >= this.maxRequests) {
      this.logger.warn('Rate limit exceeded', { userId, count: timestamps.length, limit: this.maxRequests });
      return false;
    }

    timestamps.push(now);
    this.requests.set(userId, timestamps);
    return true;
  }

  getRemainingRequests(userId: string): number {
    const now = Date.now();
    const timestamps = (this.requests.get(userId) || [])
      .filter(t => now - t < this.windowMs);
    return Math.max(0, this.maxRequests - timestamps.length);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [userId, timestamps] of this.requests.entries()) {
      const active = timestamps.filter(t => now - t < this.windowMs);
      if (active.length === 0) {
        this.requests.delete(userId);
      } else {
        this.requests.set(userId, active);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
  }
}
