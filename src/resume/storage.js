import { mkdirSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../policy.js';

export class ResumeStorageManager {
  constructor(options = {}) {
    const base = options.baseDir || process.env.RESUME_STORAGE_DIR || 'data/resumes';
    this.baseDir = resolve(base);
    this.quarantineDir = join(this.baseDir, 'quarantine');
    this.approvedDir = join(this.baseDir, 'approved');

    this.ensureDirectories();
  }

  ensureDirectories() {
    try {
      if (!existsSync(this.quarantineDir)) {
        mkdirSync(this.quarantineDir, { recursive: true, mode: 0o700 });
      }
      if (!existsSync(this.approvedDir)) {
        mkdirSync(this.approvedDir, { recursive: true, mode: 0o700 });
      }
    } catch (err) {
      throw new Error(`Failed to initialize resume storage directories: ${err.message}`, { cause: err });
    }
  }

  /**
   * Saves uploaded buffer to quarantine storage.
   * @param {Buffer} buffer
   * @returns {{ quarantineId: string, path: string }}
   */
  saveToQuarantine(buffer) {
    this.ensureDirectories();
    const quarantineId = `quarantine-${randomUUID()}`;
    const filePath = join(this.quarantineDir, `${quarantineId}.bin`);

    try {
      writeFileSync(filePath, buffer, { mode: 0o600 });
      return { quarantineId, path: filePath };
    } catch (err) {
      throw new HttpError(500, `Failed to store uploaded file in quarantine: ${err.message}`);
    }
  }

  /**
   * Promotes a quarantined file to approved storage.
   * @param {string} quarantineId
   * @returns {{ storageId: string, path: string }}
   */
  promote(quarantineId) {
    this.ensureDirectories();
    const safeQuarantineId = quarantineId.replace(/[^a-zA-Z0-9_-]/g, '');
    const quarantinePath = join(this.quarantineDir, `${safeQuarantineId}.bin`);

    if (!existsSync(quarantinePath)) {
      throw new HttpError(404, 'Quarantined file not found or expired.');
    }

    const storageId = `resume-${randomUUID()}`;
    const approvedPath = join(this.approvedDir, `${storageId}.bin`);

    try {
      renameSync(quarantinePath, approvedPath);
      return { storageId, path: approvedPath };
    } catch (err) {
      // Clean up quarantine on failure
      this.cleanupQuarantine(safeQuarantineId);
      throw new HttpError(500, `Failed to promote file to approved storage: ${err.message}`);
    }
  }

  /**
   * Removes a file from quarantine.
   * @param {string} quarantineId
   */
  cleanupQuarantine(quarantineId) {
    if (!quarantineId) return;
    const safeQuarantineId = quarantineId.replace(/[^a-zA-Z0-9_-]/g, '');
    const filePath = join(this.quarantineDir, `${safeQuarantineId}.bin`);
    try {
      if (existsSync(filePath)) {
        rmSync(filePath, { force: true });
      }
    } catch {}
  }
}
