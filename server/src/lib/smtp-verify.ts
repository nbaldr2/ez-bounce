import net from 'node:net';
import dns from 'node:dns/promises';

export interface SmtpVerdict {
  category: 'valid' | 'invalid' | 'catch_all' | 'unknown';
  reason: string;
  smtpCode: number | null;
  message: string;
}

const FROM_ADDR = process.env.REACHER_FROM_EMAIL || 'verify@localhost';
const HELO = process.env.REACHER_HELLO_NAME || 'localhost';
const TIMEOUT = 25_000;

/** Single-connection SMTP state machine: EHLO → MAIL FROM → RCPT TO → QUIT. */
async function verifyOnMx(host: string, email: string): Promise<SmtpVerdict> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: 25, timeout: TIMEOUT });
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      socket.destroy();
      resolve({ category: 'unknown', reason: 'connection_error', smtpCode: null, message: `Timeout to ${host}:25` });
    }, TIMEOUT);

    let buf = '';
    let stage = 0; // 0=banner, 1=ehlo, 2=mailfrom, 3=rcptto, 4=quit

    const send = (cmd: string) => {
      socket.write(cmd + '\r\n');
    };

    const fail = (code: number | null, reason: string, msg: string) => {
      if (timer) { clearTimeout(timer); timer = null; }
      socket.write('QUIT\r\n');
      socket.end();
      resolve({ category: 'unknown', reason, smtpCode: code, message: msg });
    };

    socket.on('connect', () => {
      // Banner arrives as data event
    });

    socket.on('data', (chunk: Buffer) => {
      if (timer) { clearTimeout(timer); timer = null; }
      buf += chunk.toString();

      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);

        // Skip intermediate multiline replies (code followed by '-')
        if (line.length >= 4 && line[3] === '-') continue;

        const code = parseInt(line.slice(0, 3), 10) || 0;

        if (stage === 0) {
          // Banner — any 4xx or 5xx means the IP is blocked or throttled
          if (code >= 400) {
            const lower = line.toLowerCase();
            const temp = code >= 400 && code < 500;
            return fail(code, temp ? 'greylisted' : 'connection_error', line);
          }
          stage = 1;
          send(`EHLO ${HELO}`);
        } else if (stage === 1) {
          const lower = line.toLowerCase();
          if (code >= 500) {
            if (lower.includes('block') || lower.includes('ptr') || lower.includes('rdns')) {
              return fail(code, 'ip_blocked', line);
            }
            return fail(code, 'connection_error', line);
          }
          if (code >= 200 && code < 300) {
            // Final EHLO response line — send MAIL FROM
            stage = 2;
            send(`MAIL FROM:<${FROM_ADDR}>`);
          }
        } else if (stage === 2) {
          if (code >= 500) {
            const lower = line.toLowerCase();
            if (lower.includes('block') || lower.includes('ptr') || lower.includes('rdns') || lower.includes('3150') || lower.includes('block list')) {
              return fail(code, 'ip_blocked', line);
            }
            return fail(code, 'connection_error', line);
          }
          if (code >= 400) {
            return fail(code, 'greylisted', line);
          }
          stage = 3;
          send(`RCPT TO:<${email}>`);
        } else if (stage === 3) {
          if (timer) { clearTimeout(timer); timer = null; }
          send('QUIT');
          socket.end();

          if (code >= 200 && code < 300) {
            resolve({ category: 'valid', reason: 'deliverable', smtpCode: code, message: line });
          } else if (code >= 400 && code < 500) {
            resolve({ category: 'unknown', reason: 'greylisted', smtpCode: code, message: line });
          } else {
            const lower = line.toLowerCase();
            if (lower.includes('user unknown') || lower.includes('no such') || lower.includes('not found') || lower.includes('does not exist')) {
              resolve({ category: 'invalid', reason: 'rejected', smtpCode: code, message: line });
            } else {
              resolve({ category: 'invalid', reason: 'rejected', smtpCode: code, message: line });
            }
          }
        }
      }

      // Reset timer for next data
      timer = setTimeout(() => {
        socket.destroy();
        resolve({ category: 'unknown', reason: 'connection_error', smtpCode: null, message: 'SMTP read timeout' });
      }, TIMEOUT);
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (timer) { clearTimeout(timer); timer = null; }
      resolve({ category: 'unknown', reason: 'connection_error', smtpCode: null, message: err.message });
    });

    socket.on('timeout', () => {
      if (timer) { clearTimeout(timer); timer = null; }
      socket.destroy();
      resolve({ category: 'unknown', reason: 'connection_error', smtpCode: null, message: `Timeout: ${host}:25` });
    });
  });
}

export async function verifyEmail(email: string): Promise<SmtpVerdict> {
  const parts = email.split('@');
  const domain = parts[1];
  if (!domain) {
    return { category: 'invalid', reason: 'invalid_syntax', smtpCode: null, message: 'No domain in email' };
  }

  let mxRecords: { exchange: string; priority: number }[] = [];
  try {
    mxRecords = await dns.resolveMx(domain);
  } catch {
    return { category: 'invalid', reason: 'no_mx', smtpCode: null, message: `DNS failed for ${domain}` };
  }

  if (mxRecords.length === 0) {
    return { category: 'invalid', reason: 'no_mx', smtpCode: null, message: `No MX records for ${domain}` };
  }

  mxRecords.sort((a, b) => a.priority - b.priority);

  for (const mx of mxRecords.slice(0, 2)) {
    const host = mx.exchange.replace(/\.$/, '');
    const result = await verifyOnMx(host, email);
    // Return on any definitive result, including temp-fails that will be retried
    if (result.category !== 'unknown' || result.reason !== 'connection_error') {
      return result;
    }
  }

  return { category: 'unknown', reason: 'connection_error', smtpCode: null, message: 'All MX connections failed' };
}