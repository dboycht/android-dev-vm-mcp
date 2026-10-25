// Small process / fs / network helpers shared by all modules. Windows-first.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// MCP stdio: stdout is protocol-only, so all diagnostics go to stderr.
export function log(...parts) {
  try {
    process.stderr.write(`[${new Date().toISOString()}] ${parts.join(' ')}\n`);
  } catch {}
}

export function clip(s, max = 30000) {
  s = String(s ?? '');
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n...[truncated, ${s.length - max} more chars]`;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function killTree(pid) {
  if (!pid) return;
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {}
}

function cmdQuote(a) {
  if (a === '' || /[\s;&|<>()%!^"]/.test(a)) return `"${a.replace(/"/g, '""')}"`;
  return a;
}

// Spawn a child, collect output, enforce a hard timeout (tree-kill on Windows).
// Returns { code, timeout, error, stdout, stderr, stdoutBuf } — stdoutBuf is raw
// bytes for binary output (screencap, file pulls).
export function run(file, args = [], opts = {}) {
  const { timeoutMs = 60000, cwd, stdin, env, onLine } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      // Node >=18.20 refuses to spawn .bat/.cmd without a shell (EINVAL).
      // With shell:true, cmd.exe batch splitting treats ';' as an argument
      // separator, so quote args containing spaces / cmd metacharacters.
      const needsShell = /\.(bat|cmd)$/i.test(file);
      if (needsShell) {
        const line = [file, ...args].map(cmdQuote).join(' ');
        child = spawn(line, { cwd, env, windowsHide: true, shell: true });
      } else {
        child = spawn(file, args, { cwd, env, windowsHide: true });
      }
    } catch (e) {
      resolve({ code: -1, error: String(e), stdout: '', stderr: '', stdoutBuf: Buffer.alloc(0) });
      return;
    }
    const out = [];
    const err = [];
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      killTree(child.pid);
      finish({
        code: -1,
        timeout: true,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8') + `\n[timeout after ${timeoutMs}ms]`,
        stdoutBuf: Buffer.concat(out),
      });
    }, timeoutMs);
    const feed = (buf, sink) => {
      sink.push(buf);
      if (onLine) {
        for (const line of buf.toString('utf8').split(/\r\n|\n|\r/)) {
          if (line) onLine(line);
        }
      }
    };
    child.stdout.on('data', (d) => feed(d, out));
    child.stderr.on('data', (d) => feed(d, err));
    child.on('error', (e) => {
      finish({
        code: -1,
        error: String(e),
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        stdoutBuf: Buffer.concat(out),
      });
    });
    child.on('close', (code) => {
      finish({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        stdoutBuf: Buffer.concat(out),
      });
    });
    if (stdin != null) {
      try { child.stdin.write(stdin); } catch {}
    }
    try { child.stdin.end(); } catch {}
  });
}

// Detached spawn: the emulator must outlive this process (and the MCP session).
export function spawnDetached(file, args, { env, logFile } = {}) {
  ensureDir(path.dirname(logFile));
  const out = fs.openSync(logFile, 'a');
  fs.writeSync(out, `\n[${new Date().toISOString()}] spawn: ${file} ${args.join(' ')}\n`);
  const child = spawn(file, args, { env, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  fs.closeSync(out);
  return child.pid;
}

export async function download(url, dest, { onProgress } = {}) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  ensureDir(path.dirname(dest));
  const tmp = dest + '.part';
  const f = fs.createWriteStream(tmp);
  let got = 0;
  let lastPct = -1;
  for await (const chunk of res.body) {
    got += chunk.length;
    if (!f.write(Buffer.from(chunk))) {
      await new Promise((r) => f.once('drain', r));
    }
    if (onProgress && total) {
      const pct = Math.floor((got / total) * 100);
      if (pct >= lastPct + 5) {
        lastPct = pct;
        onProgress({ got, total, pct });
      }
    }
  }
  await new Promise((r) => f.end(r));
  fs.renameSync(tmp, dest);
  return { bytes: got, total };
}

// dl.google.com throttles per connection (~150-300 KB/s observed); the CDN
// accepts Range requests, so split the file and fetch chunks in parallel.
export async function downloadParallel(url, dest, { connections = 8, onProgress } = {}) {
  ensureDir(path.dirname(dest));
  const head = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
  if (!head.ok) throw new Error(`HTTP ${head.status} for ${url}`);
  const acceptsRange = head.status === 206;
  const total = Number(head.headers.get('content-range')?.split('/')[1] || head.headers.get('content-length') || 0);
  await head.body?.cancel();
  if (!acceptsRange || !total) {
    log('server does not accept ranges — single-stream fallback');
    return download(url, dest, { onProgress });
  }
  const tmp = dest + '.part';
  const chunkSize = Math.ceil(total / connections);
  const bounds = [];
  for (let i = 0; i < connections; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, total) - 1;
    if (start <= end) bounds.push([start, end]);
  }
  const fh = await fs.promises.open(tmp, 'w');
  const gotByChunk = new Array(bounds.length).fill(0);
  let done = false;
  const tick = () => {
    if (done || !onProgress) return;
    const got = gotByChunk.reduce((a, b) => a + b, 0);
    const pct = Math.floor((got / total) * 100);
    onProgress({ got, total, pct });
  };
  const worker = async ([start, end], idx, attempt = 1) => {
    // A stalled connection never errors on its own — hard-timeout every
    // attempt; the retry resumes from the bytes this chunk already received.
    const res = await fetch(url, {
      headers: { Range: `bytes=${start + gotByChunk[idx]}-${end}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(240000),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} (chunk ${idx})`);
    let pos = start + gotByChunk[idx];
    for await (const chunk of res.body) {
      await fh.write(Buffer.from(chunk), 0, chunk.length, pos);
      pos += chunk.length;
      gotByChunk[idx] = pos - start;
    }
    if (pos !== end + 1) throw new Error(`chunk ${idx} short: got ${pos - start}/${end - start + 1}`);
  };
  await Promise.all(bounds.map(async ([s, e], idx) => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await worker([s, e], idx, attempt);
        return;
      } catch (err) {
        if (attempt === 5) throw err;
        log(`chunk ${idx} attempt ${attempt} failed (${clip(String(err.message || err), 120)}), retrying`);
        await sleep(1500 * attempt);
      }
    }
  }));
  await fh.close();
  const expected = bounds.reduce((a, [s, e]) => a + (e - s + 1), 0);
  const size = (await fs.promises.stat(tmp)).size;
  if (size !== expected) throw new Error(`size mismatch after parallel download: ${size}/${expected}`);
  fs.renameSync(tmp, dest);
  done = true;
  return { bytes: total, total };
}

// Windows 10+ ships bsdtar at System32\tar.exe which reads zip files.
// Git Bash's GNU tar cannot, so use the absolute path.
const WIN_TAR = 'C:\\Windows\\System32\\tar.exe';
export async function unzip(zipPath, destDir) {
  ensureDir(destDir);
  const exe = fs.existsSync(WIN_TAR) ? WIN_TAR : 'tar';
  const r = await run(exe, ['-xf', zipPath, '-C', destDir], { timeoutMs: 600000 });
  if (r.code !== 0) throw new Error(`unzip failed: ${clip(r.stderr, 600)}`);
}

// Quote a string as one argument for the device-side shell (single quotes).
export function deviceQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function tailFile(p, lines = 40) {
  try {
    const buf = fs.readFileSync(p);
    const text = buf.toString('utf8');
    const all = text.split(/\r\n|\n/);
    return clip(all.slice(-lines).join('\n'), 6000);
  } catch {
    return '(no log file)';
  }
}
