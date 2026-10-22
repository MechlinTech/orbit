/**
 * Signature Storage Manager for Orbit ATS
 * Manages private, access-controlled local storage for documents,
 * signature assets (uploaded images, drawn signatures), and completed signed outputs.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../policy.js';

function isPathSafe(baseDir, targetPath) {
  const rel = relative(baseDir, resolve(targetPath));
  return !rel.startsWith('..') && !isAbsolute(rel);
}

export class SignatureStorageManager {
  constructor(options = {}) {
    const base = typeof options === 'string'
      ? options
      : (options?.baseDir || process.env.SIGNATURE_STORAGE_DIR || 'data/signatures');
    this.baseDir = resolve(base);
    this.documentsDir = join(this.baseDir, 'documents');
    this.assetsDir = join(this.baseDir, 'assets');
    this.signedDir = join(this.baseDir, 'signed');

    this.ensureDirectories();
  }

  writeFile(filePath, buffer) {
    const resolvedPath = resolve(filePath);
    if (!isPathSafe(this.baseDir, resolvedPath)) {
      throw new HttpError(403, 'Unauthorized storage access path traversal detected.');
    }
    writeFileSync(resolvedPath, buffer, { mode: 0o600 });
  }

  ensureDirectories() {
    try {
      for (const dir of [this.baseDir, this.documentsDir, this.assetsDir, this.signedDir]) {
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
      }
    } catch (err) {
      throw new Error(`Failed to initialize signature storage: ${err.message}`, { cause: err });
    }
  }

  /**
   * Computes SHA-256 hex digest of a buffer.
   */
  hash(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Stores an original document buffer.
   * @param {Buffer} buffer
   * @param {string} filename
   * @returns {{ documentId: string, storagePath: string, sha256: string, size: number }}
   */
  saveDocument(buffer, filename = 'document.pdf') {
    this.ensureDirectories();
    const documentId = `doc-${randomUUID()}`;
    const safeExt = filename.toLowerCase().endsWith('.pdf') ? '.pdf' : '.pdf';
    const filePath = join(this.documentsDir, `${documentId}${safeExt}`);
    const sha256 = this.hash(buffer);

    try {
      writeFileSync(filePath, buffer, { mode: 0o600 });
      return {
        documentId,
        storagePath: filePath,
        sha256,
        size: buffer.length
      };
    } catch (err) {
      throw new HttpError(500, `Failed to store document: ${err.message}`);
    }
  }

  /**
   * Stores a signature asset (uploaded image or drawn signature).
   * @param {Buffer} buffer
   * @param {string} format 'png' | 'jpeg'
   * @returns {{ assetId: string, storagePath: string, sha256: string, size: number }}
   */
  saveSignatureAsset(buffer, format = 'png') {
    this.ensureDirectories();
    const assetId = `sig-${randomUUID()}`;
    const ext = format.toLowerCase() === 'jpeg' || format.toLowerCase() === 'jpg' ? '.jpg' : '.png';
    const filePath = join(this.assetsDir, `${assetId}${ext}`);
    const sha256 = this.hash(buffer);

    try {
      writeFileSync(filePath, buffer, { mode: 0o600 });
      return {
        assetId,
        storagePath: filePath,
        sha256,
        size: buffer.length
      };
    } catch (err) {
      throw new HttpError(500, `Failed to store signature asset: ${err.message}`);
    }
  }

  /**
   * Stores final completed signed document.
   * @param {Buffer} buffer
   * @param {string} requestId
   * @returns {{ storagePath: string, sha256: string, size: number }}
   */
  saveSignedDocument(buffer, requestId) {
    this.ensureDirectories();
    const safeId = requestId.replace(/[^a-zA-Z0-9_-]/g, '');
    const filePath = join(this.signedDir, `${safeId}-signed.pdf`);
    const sha256 = this.hash(buffer);

    try {
      writeFileSync(filePath, buffer, { mode: 0o600 });
      return {
        storagePath: filePath,
        sha256,
        size: buffer.length
      };
    } catch (err) {
      throw new HttpError(500, `Failed to store signed document: ${err.message}`);
    }
  }

  /**
   * Reads a stored document by path, verifying it is within the baseDir.
   */
  readFile(filePath) {
    const resolvedPath = resolve(filePath);
    if (!isPathSafe(this.baseDir, resolvedPath)) {
      throw new HttpError(403, 'Unauthorized storage access path traversal detected.');
    }
    if (!existsSync(resolvedPath)) {
      throw new HttpError(404, 'Stored document or asset not found.');
    }
    return readFileSync(resolvedPath);
  }

  /**
   * Stores a typed signature rendered image asset for high-fidelity PDF placement.
   */
  saveTypedSignatureAsset(signerId, buffer) {
    this.ensureDirectories();
    const safeId = String(signerId).replace(/[^a-zA-Z0-9_-]/g, '');
    const filePath = join(this.assetsDir, `typed-${safeId}.png`);
    this.writeFile(filePath, buffer);
    return filePath;
  }

  /**
   * Returns path to typed signature image asset if it exists.
   */
  getTypedSignatureAssetPath(signerId) {
    const safeId = String(signerId).replace(/[^a-zA-Z0-9_-]/g, '');
    const filePath = join(this.assetsDir, `typed-${safeId}.png`);
    return existsSync(filePath) ? filePath : null;
  }

  /**
   * Deletes a stored file safely.
   */
  cleanup(filePath) {
    try {
      const resolvedPath = resolve(filePath);
      if (isPathSafe(this.baseDir, resolvedPath) && existsSync(resolvedPath)) {
        rmSync(resolvedPath, { force: true });
      }
    } catch {}
  }
}
