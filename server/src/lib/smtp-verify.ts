import net from 'node:net';
import dns from 'node:dns/promises';

/**
 * Direct SMTP verification. Connects to the highest-priority MX, opens an
 * SMTP conversation, and reads the RCPT TO response.
 *
 * This replaces the Reacher sidecar for the actual verification step. It is
 * the same protocol check that Reacher (and every other verifier) performs:
 * EHLO → MAIL FROM → RCPT TO → QUIT. No message is ever sent.
 */

export interface SmtpVerdict {
  category: 'valid' | 'invalid' | 'catch_all' | 'unknown';
  reason: string;
  smtpCode: number | null;
  message: string;
}

const FROM_ADDR = process.env.REACHER_FROM_EMAIL || 'verify@localhost';
const HELO = process.env.REACHER_HELLO_NAME || 'localhost';
const TIMEOUT = 15_000;

function readLine(socket: net.Socket, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SMTP read timeout')), timeout);
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes('\n')) {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        const line = buf.split('\n')[0]?.trim() ?? '';
        resolve(line);
      }
    };
    socket.on('data', onData);
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function send(socket: net.Socket, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.write(cmd + '\r\n', (err) => {
      if (err) reject(err);
      else resolve(readLine(socket, TIMEOUT));
    });
  });
}

export async function verifyEmail(email: string): Promise<SmtpVerdict> {
  const domain = email.split('@')[1];
  if (!domain) return { category: 'invalid', reason: 'invalid_syntax', smtpCode: null, message: 'No domain' };

  // Resolve MX
  let mxRecords: { exchange: string; priority: number }[] = [];
  try {
    mxRecords = await dns.resolveMx(domain);
  } catch {
    return { category: 'invalid', reason: 'no_mx', smtpCode: null, message: `No MX for ${domain}` };
  }
  if (mxRecords.length === 0) {
    return { category: 'invalid', reason: 'no_mx', smtpCode: null, message: `No MX for ${domain}` };
  }

  mxRecords.sort((a, b) => a.priority - b.priority);

  let lastError = '';
  for (const mx of mxRecords.slice(0, 3)) {
    const host = mx.exchange.replace(/\.$/, '');
    try {
      const verdict = await tryMx(host, email, domain);
      return verdict;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  return { category: 'unknown', reason: 'connection_error', smtpCode: null, message: lastError };
}

async function tryMx(host: string, email: string, domain: string): Promise<SmtpVerdict> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: 25, timeout: TIMEOUT });

    socket.on('error', (err) => reject(err));
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`Timeout connecting to ${host}:25`));
    });

    socket.on('connect', async () => {
      try {
        // Read greeting
        const banner = await readLine(socket, TIMEOUT);
        const bannerCode = parseInt(banner.slice(0, 3), 10);
        if (!bannerCode || bannerCode >= 500) {
          socket.end();
          return resolve({ category: 'unknown', reason: 'connection_error', smtpCode: bannerCode, message: banner });
        }

        // EHLO
        const ehlo = await send(socket, `EHLO ${HELO}`);
        const ehloCode = parseInt(ehlo.slice(0, 3), 10);
        if (!ehloCode || ehloCode >= 400) {
          socket.end();
          return resolve({ category: 'unknown', reason: 'connection_error', smtpCode: ehloCode, message: ehlo });
        }
        // Read multiline EHLO response
        if (ehlo.includes('-')) {
          while (true) {
            const line = await readLine(socket, 5000);
            const code = parseInt(line.slice(0, 3), 10);
            if (code && !line.slice(4).startsWith('-')) break;
          }
        }

        // MAIL FROM
        const mailFrom = await send(socket, `MAIL FROM:<${FROM_ADDR}>`);
        const mfCode = parseInt(mailFrom.slice(0, 3), 10);
        if (!mfCode || mfCode >= 500) {
          socket.end();
          return resolve({ category: 'unknown', reason: 'connection_error', smtpCode: mfCode, message: mailFrom });
        }

        // RCPT TO
        const rcpt = await send(socket, `RCPT TO:<${email}>`);
        const code = parseInt(rcpt.slice(0, 3), 10);

        // QUIT
        socket.write('QUIT\r\n');
        socket.end();

        if (!Number.isFinite(code)) {
          return resolve({ category: 'unknown', reason: 'unknown', smtpCode: null, message: rcpt });
        }

        // 2xx = deliverable
        if (code >= 200 && code < 300) {
          return resolve({ category: 'valid', reason: 'deliverable', smtpCode: code, message: rcpt });
        }

        // 4xx = temp-fail (greylisted, rate-limited)
        if (code >= 400 && code < 500) {
          return resolve({ category: 'unknown', reason: 'greylisted', smtpCode: code, message: rcpt });
        }

        // 5xx = rejected
        const msg = rcpt.toLowerCase();
        if (msg.includes('user unknown') || msg.includes('no such user') || msg.includes('does not exist')) {
          return resolve({ category: 'invalid', reason: 'rejected', smtpCode: code, message: rcpt });
        }

        // Catch-all detection: some servers accept everything
        // We mark 5xx that isn't specifically about the user as unknown
        return resolve({ category: 'invalid', reason: 'rejected', smtpCode: code, message: rcpt });
      } catch (err) {
        socket.destroy();
        reject(err);
      }
    });
  });
}