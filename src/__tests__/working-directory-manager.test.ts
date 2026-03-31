import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

// Mock config before importing the module
vi.mock('../config', () => ({
  config: {
    debug: false,
    baseDirectory: undefined,
  },
}));

import { WorkingDirectoryManager } from '../working-directory-manager';
import * as os from 'os';
import * as path from 'path';

describe('WorkingDirectoryManager', () => {
  let manager: WorkingDirectoryManager;

  beforeEach(() => {
    manager = new WorkingDirectoryManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  describe('getConfigKey', () => {
    it('returns channelId for regular channels', () => {
      expect(manager.getConfigKey('C123')).toBe('C123');
    });

    it('returns channelId-threadTs for threads', () => {
      expect(manager.getConfigKey('C123', 'ts123')).toBe('C123-ts123');
    });

    it('returns channelId-userId for DMs', () => {
      expect(manager.getConfigKey('D456', undefined, 'U789')).toBe('D456-U789');
    });

    it('prefers threadTs over userId', () => {
      expect(manager.getConfigKey('C123', 'ts123', 'U789')).toBe('C123-ts123');
    });
  });

  describe('setWorkingDirectory / getWorkingDirectory', () => {
    it('sets and gets a valid directory', () => {
      const tmpDir = os.tmpdir();
      const result = manager.setWorkingDirectory('C123', tmpDir);
      expect(result.success).toBe(true);
      expect(result.resolvedPath).toBe(path.resolve(tmpDir));

      const dir = manager.getWorkingDirectory('C123');
      expect(dir).toBe(path.resolve(tmpDir));
    });

    it('fails for non-existent directory', () => {
      const result = manager.setWorkingDirectory('C123', '/nonexistent/path/xyz');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('thread-specific overrides channel config', () => {
      const tmpDir = os.tmpdir();
      const homeDir = process.env.HOME || '/tmp';

      manager.setWorkingDirectory('C123', tmpDir);
      manager.setWorkingDirectory('C123', homeDir, 'ts456');

      // Thread should get its own config
      expect(manager.getWorkingDirectory('C123', 'ts456')).toBe(path.resolve(homeDir));
      // Channel without thread should get channel config
      expect(manager.getWorkingDirectory('C123')).toBe(path.resolve(tmpDir));
    });
  });

  describe('parseSetCommand', () => {
    it('parses cwd command', () => {
      expect(manager.parseSetCommand('cwd /tmp')).toBe('/tmp');
      expect(manager.parseSetCommand('cwd   /tmp  ')).toBe('/tmp');
      expect(manager.parseSetCommand('CWD /tmp')).toBe('/tmp');
    });

    it('parses set directory command', () => {
      expect(manager.parseSetCommand('set directory /tmp')).toBe('/tmp');
      expect(manager.parseSetCommand('set working-directory /tmp')).toBe('/tmp');
    });

    it('returns null for non-matching text', () => {
      expect(manager.parseSetCommand('hello world')).toBeNull();
      expect(manager.parseSetCommand('cwd')).toBeNull();
    });
  });

  describe('isGetCommand', () => {
    it('matches get commands', () => {
      expect(manager.isGetCommand('cwd')).toBe(true);
      expect(manager.isGetCommand('cwd?')).toBe(true);
      expect(manager.isGetCommand('dir')).toBe(true);
      expect(manager.isGetCommand('get cwd')).toBe(true);
    });

    it('rejects non-get commands', () => {
      expect(manager.isGetCommand('cwd /tmp')).toBe(false);
      expect(manager.isGetCommand('hello')).toBe(false);
    });
  });

  describe('removeWorkingDirectory', () => {
    it('removes an existing config', () => {
      manager.setWorkingDirectory('C123', os.tmpdir());
      expect(manager.removeWorkingDirectory('C123')).toBe(true);
      expect(manager.getWorkingDirectory('C123')).not.toBe(path.resolve(os.tmpdir()));
    });

    it('returns false for non-existent config', () => {
      expect(manager.removeWorkingDirectory('C999')).toBe(false);
    });
  });

  describe('cleanupStaleConfigs', () => {
    it('removes entries older than maxAge', () => {
      manager.setWorkingDirectory('C123', os.tmpdir(), 'ts1');
      // Manually set lastAccessed to the past
      const configs = manager.listConfigurations();
      configs[0].lastAccessed = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago

      manager.cleanupStaleConfigs(60 * 60 * 1000); // 1 hour thread TTL
      expect(manager.listConfigurations()).toHaveLength(0);
    });

    it('keeps channel-level configs longer than thread-level', () => {
      manager.setWorkingDirectory('C123', os.tmpdir()); // channel-level (no threadTs)
      const configs = manager.listConfigurations();
      configs[0].lastAccessed = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago

      manager.cleanupStaleConfigs(60 * 60 * 1000, 24 * 60 * 60 * 1000);
      // Should still exist (channel TTL is 24h)
      expect(manager.listConfigurations()).toHaveLength(1);
    });
  });
});
