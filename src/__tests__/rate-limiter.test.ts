import { describe, it, expect, afterEach } from 'vitest';
import { RateLimiter } from '../rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.destroy();
  });

  it('allows requests under the limit', () => {
    limiter = new RateLimiter(3, 60000);
    expect(limiter.isAllowed('user1')).toBe(true);
    expect(limiter.isAllowed('user1')).toBe(true);
    expect(limiter.isAllowed('user1')).toBe(true);
  });

  it('blocks requests over the limit', () => {
    limiter = new RateLimiter(2, 60000);
    expect(limiter.isAllowed('user1')).toBe(true);
    expect(limiter.isAllowed('user1')).toBe(true);
    expect(limiter.isAllowed('user1')).toBe(false);
  });

  it('isolates users', () => {
    limiter = new RateLimiter(1, 60000);
    expect(limiter.isAllowed('user1')).toBe(true);
    expect(limiter.isAllowed('user1')).toBe(false);
    expect(limiter.isAllowed('user2')).toBe(true);
  });

  it('reports remaining requests correctly', () => {
    limiter = new RateLimiter(5, 60000);
    expect(limiter.getRemainingRequests('user1')).toBe(5);
    limiter.isAllowed('user1');
    limiter.isAllowed('user1');
    expect(limiter.getRemainingRequests('user1')).toBe(3);
  });

  it('allows requests again after window expires', async () => {
    limiter = new RateLimiter(1, 50); // 50ms window
    expect(limiter.isAllowed('user1')).toBe(true);
    expect(limiter.isAllowed('user1')).toBe(false);

    await new Promise(r => setTimeout(r, 60));
    expect(limiter.isAllowed('user1')).toBe(true);
  });
});
