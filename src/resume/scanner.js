import net from 'node:net';

export const SCAN_STATUS = {
  CLEAN: 'clean',
  INFECTED: 'infected',
  SCAN_FAILED: 'scan_failed',
  SCANNER_UNAVAILABLE: 'scanner_unavailable',
  UNSCANNED: 'unscanned'
};

/**
 * Base Antivirus Scanner interface.
 */
export class AntivirusScanner {
  constructor(options = {}) {
    this.name = options.name || 'BaseScanner';
  }

  /**
   * Scans a file buffer or path.
   * @param {Buffer} buffer
   * @param {string} [filePath]
   * @returns {Promise<{ status: string, message?: string, virusName?: string }>}
   */
  async scan(buffer, filePath) {
    throw new Error('Not implemented');
  }
}

/**
 * ClamAV daemon TCP scanner using the INSTREAM protocol.
 */
export class ClamAvScanner extends AntivirusScanner {
  constructor(options = {}) {
    super({ name: 'ClamAV', ...options });
    this.host = options.host || process.env.CLAMAV_HOST || '127.0.0.1';
    this.port = Number(options.port || process.env.CLAMAV_PORT || 3310);
    this.timeout = Number(options.timeout || process.env.CLAMAV_TIMEOUT_MS || 5000);
  }

  async scan(buffer) {
    if (!buffer || buffer.length === 0) {
      return { status: SCAN_STATUS.SCAN_FAILED, message: 'Cannot scan empty buffer.' };
    }

    return new Promise((resolve) => {
      let resolved = false;
      const done = (result) => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          resolve(result);
        }
      };

      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setTimeout(this.timeout);

      let responseData = '';

      socket.on('connect', () => {
        // ClamAV INSTREAM protocol:
        // 1. Send 'zINSTREAM\0'
        // 2. Send chunks: 4 bytes big-endian length + chunk
        // 3. Send 4 zero bytes
        socket.write('zINSTREAM\0');

        const chunkSize = 64 * 1024;
        let offset = 0;

        while (offset < buffer.length) {
          const end = Math.min(offset + chunkSize, buffer.length);
          const chunk = buffer.subarray(offset, end);
          const header = Buffer.alloc(4);
          header.writeUInt32BE(chunk.length, 0);

          socket.write(header);
          socket.write(chunk);
          offset = end;
        }

        // Zero-length packet signals end of stream
        const term = Buffer.alloc(4, 0);
        socket.write(term);
      });

      socket.on('data', (data) => {
        responseData += data.toString('utf8');
      });

      socket.on('end', () => {
        const trimmed = responseData.trim();
        if (trimmed.includes('stream: OK')) {
          done({ status: SCAN_STATUS.CLEAN });
        } else if (trimmed.includes('FOUND')) {
          const match = trimmed.match(/stream:\s*(.+?)\s+FOUND/i);
          const virusName = match ? match[1] : 'Unknown threat';
          done({ status: SCAN_STATUS.INFECTED, virusName, message: `Malware detected: ${virusName}` });
        } else {
          done({ status: SCAN_STATUS.SCAN_FAILED, message: trimmed || 'Unrecognized scanner output.' });
        }
      });

      socket.on('timeout', () => {
        done({ status: SCAN_STATUS.SCANNER_UNAVAILABLE, message: 'ClamAV scanner connection timed out.' });
      });

      socket.on('error', (err) => {
        done({ status: SCAN_STATUS.SCANNER_UNAVAILABLE, message: `ClamAV scanner unavailable: ${err.message}` });
      });
    });
  }
}

/**
 * Creates scanner instance based on configuration and environment.
 */
export function createScanner(options = {}) {
  const provider = (options.antivirusProvider || process.env.ANTIVIRUS_PROVIDER || '').toLowerCase();
  const isRequired = options.antivirusRequired !== undefined 
    ? Boolean(options.antivirusRequired)
    : (process.env.ANTIVIRUS_REQUIRED === 'true' || process.env.NODE_ENV === 'production');

  if (options.customScanner) {
    return options.customScanner;
  }

  if (provider === 'clamav') {
    return new ClamAvScanner(options);
  }

  if (provider === 'mock' || provider === 'eicar') {
    return {
      name: 'MockScanner',
      isRequired,
      async scan(buffer) {
        const raw = Buffer.isBuffer(buffer) ? buffer.toString('binary') : String(buffer || '');
        if (raw.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) {
          return { status: SCAN_STATUS.INFECTED, virusName: 'Eicar-Test-Signature', message: 'Malware detected in uploaded file.' };
        }
        return { status: SCAN_STATUS.CLEAN, message: 'Scan clean.' };
      }
    };
  }

  if (provider === 'unavailable') {
    return {
      name: 'UnavailableScanner',
      isRequired,
      async scan() {
        return { status: SCAN_STATUS.SCANNER_UNAVAILABLE, message: 'Antivirus scanner unavailable.' };
      }
    };
  }

  // If no scanner is configured
  return {
    name: 'UnconfiguredScanner',
    isRequired,
    async scan() {
      if (isRequired) {
        return {
          status: SCAN_STATUS.SCANNER_UNAVAILABLE,
          message: 'Antivirus scanner is required in this environment but no service is configured.'
        };
      }
      return {
        status: SCAN_STATUS.UNSCANNED,
        message: 'No antivirus scanner configured in development environment.'
      };
    }
  };
}
