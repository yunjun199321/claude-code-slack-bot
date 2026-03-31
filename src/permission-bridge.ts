import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from './logger';

const logger = new Logger('PermissionBridge');

const BRIDGE_DIR = path.join(os.tmpdir(), 'cc-slack-bot-approvals');

// Ensure bridge directory exists
try {
  fs.mkdirSync(BRIDGE_DIR, { recursive: true });
} catch {}

interface ApprovalResult {
  approved: boolean;
  updatedInput?: any;
}

/**
 * Write an approval result from the main process (Slack button click).
 * The subprocess polls for this file.
 */
export function writeApprovalResult(approvalId: string, approved: boolean): void {
  const resultFile = path.join(BRIDGE_DIR, `${approvalId}.result`);
  const result: ApprovalResult = { approved };
  fs.writeFileSync(resultFile, JSON.stringify(result), 'utf-8');
  logger.info('Wrote approval result', { approvalId, approved });
}

/**
 * Wait for an approval result from the main process (called from subprocess).
 * Polls the filesystem for a result file.
 */
export async function waitForApprovalResult(
  approvalId: string,
  timeoutMs: number = 5 * 60 * 1000,
  pollIntervalMs: number = 500,
): Promise<ApprovalResult> {
  const resultFile = path.join(BRIDGE_DIR, `${approvalId}.result`);
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const check = () => {
      try {
        if (fs.existsSync(resultFile)) {
          const content = fs.readFileSync(resultFile, 'utf-8');
          // Clean up
          try { fs.unlinkSync(resultFile); } catch {}
          resolve(JSON.parse(content) as ApprovalResult);
          return;
        }
      } catch (err) {
        logger.error('Error reading approval result', err);
      }

      if (Date.now() >= deadline) {
        // Clean up any stale files
        try { fs.unlinkSync(resultFile); } catch {}
        resolve({ approved: false }); // Timeout = deny
        return;
      }

      setTimeout(check, pollIntervalMs);
    };

    check();
  });
}

/**
 * Clean up stale approval files (older than 10 minutes).
 */
export function cleanupStaleApprovals(): void {
  try {
    if (!fs.existsSync(BRIDGE_DIR)) return;
    const now = Date.now();
    for (const file of fs.readdirSync(BRIDGE_DIR)) {
      const filePath = path.join(BRIDGE_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > 10 * 60 * 1000) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (err) {
    logger.error('Error cleaning up stale approvals', err);
  }
}
