import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config', () => ({
  config: { debug: true },
}));

import { Logger } from '../logger';

describe('Logger', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger('TestContext');
  });

  it('audit outputs valid JSON with required fields', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.audit('test.event', { user: 'U123', action: 'click' });

    expect(spy).toHaveBeenCalledOnce();
    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output.level).toBe('AUDIT');
    expect(output.context).toBe('TestContext');
    expect(output.event).toBe('test.event');
    expect(output.user).toBe('U123');
    expect(output.timestamp).toBeDefined();

    spy.mockRestore();
  });

  it('info logs with correct format', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.info('test message');

    expect(spy).toHaveBeenCalledOnce();
    const output = spy.mock.calls[0][0];
    expect(output).toContain('[INFO]');
    expect(output).toContain('[TestContext]');
    expect(output).toContain('test message');

    spy.mockRestore();
  });
});
