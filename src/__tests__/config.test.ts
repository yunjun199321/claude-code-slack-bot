import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('config.adminUsers', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('parses comma-separated admin users', async () => {
    vi.stubEnv('ADMIN_USERS', 'U123,U456,U789');
    vi.stubEnv('SLACK_BOT_TOKEN', 'test');
    vi.stubEnv('SLACK_APP_TOKEN', 'test');
    vi.stubEnv('SLACK_SIGNING_SECRET', 'test');
    const { config } = await import('../config');
    expect(config.adminUsers).toEqual(['U123', 'U456', 'U789']);
    vi.unstubAllEnvs();
  });

  it('handles empty ADMIN_USERS', async () => {
    vi.stubEnv('ADMIN_USERS', '');
    vi.stubEnv('SLACK_BOT_TOKEN', 'test');
    vi.stubEnv('SLACK_APP_TOKEN', 'test');
    vi.stubEnv('SLACK_SIGNING_SECRET', 'test');
    const { config } = await import('../config');
    expect(config.adminUsers).toEqual([]);
    vi.unstubAllEnvs();
  });

  it('handles undefined ADMIN_USERS', async () => {
    delete process.env.ADMIN_USERS;
    vi.stubEnv('SLACK_BOT_TOKEN', 'test');
    vi.stubEnv('SLACK_APP_TOKEN', 'test');
    vi.stubEnv('SLACK_SIGNING_SECRET', 'test');
    const { config } = await import('../config');
    expect(config.adminUsers).toEqual([]);
    vi.unstubAllEnvs();
  });

  it('trims whitespace from admin user IDs', async () => {
    vi.stubEnv('ADMIN_USERS', ' U123 , U456 ');
    vi.stubEnv('SLACK_BOT_TOKEN', 'test');
    vi.stubEnv('SLACK_APP_TOKEN', 'test');
    vi.stubEnv('SLACK_SIGNING_SECRET', 'test');
    const { config } = await import('../config');
    expect(config.adminUsers).toEqual(['U123', 'U456']);
    vi.unstubAllEnvs();
  });
});
