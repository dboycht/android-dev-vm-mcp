// Thin adb wrappers: device listing, target resolution, shell with timeout,
// binary-safe screencap, package/app management helpers.
import fs from 'node:fs';
import {
  ADB_EXE, DATA_DIR, EMU_SERIAL, RUNTIME_FILE, fullEnv,
} from './config.mjs';
import { run, clip, ensureDir } from './util.mjs';

// The serial this project actually booted (may differ from EMU_SERIAL when
// another emulator holds the default port). Persisted by emulator.boot().
export function readRuntime() {
  try {
    return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function readRuntimeSerial() {
  return readRuntime()?.serial || null;
}

export function writeRuntime(obj) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

export async function adb(args, opts = {}) {
  return run(ADB_EXE, args, { timeoutMs: 60000, env: fullEnv(), ...opts });
}

export async function adbOk(args, opts = {}) {
  const r = await adb(args, opts);
  if (r.code !== 0) {
    throw new Error(`adb ${args.join(' ')} failed (exit ${r.code}): ${clip((r.stderr || r.stdout || '').trim(), 800)}`);
  }
  return r;
}

export async function listDevices() {
  const r = await adbOk(['devices', '-l'], { timeoutMs: 15000 });
  return r.stdout
    .split(/\r?\n/)
    .slice(1)
    .filter((l) => l.trim() && !l.startsWith('*'))
    .map((l) => {
      const parts = l.trim().split(/\s+/);
      const model = (l.match(/model:(\S+)/) || [])[1] || '';
      return { serial: parts[0], state: parts[1] || '?', model };
    });
}

// Pick the device for tool calls: explicit serial > our booted emulator >
// default emulator port > only device.
export async function resolveSerial(serial) {
  const devs = await listDevices();
  if (serial) {
    if (devs.some((d) => d.serial === serial)) return serial;
    throw new Error(`device "${serial}" not found. Connected: ${fmtDevs(devs)}`);
  }
  const online = new Set(devs.filter((d) => d.state === 'device').map((d) => d.serial));
  const ours = readRuntimeSerial();
  if (ours && online.has(ours)) return ours;
  if (online.has(EMU_SERIAL)) return EMU_SERIAL;
  const usable = devs.filter((d) => d.state === 'device');
  if (usable.length === 1) return usable[0].serial;
  throw new Error(`No target device. Connected: ${fmtDevs(devs) || 'none'}. Boot the emulator (android_emulator_boot) or pass a serial.`);
}

function fmtDevs(devs) {
  return devs.map((d) => `${d.serial}(${d.state})`).join(', ');
}

// Run a shell command on device. adb forwards the whole string as one command;
// quoting inside is device-side.
export async function shell(serial, cmd, opts = {}) {
  const r = await adb(['-s', serial, 'shell', cmd], { timeoutMs: 30000, ...opts });
  return { ...r, out: r.stdout.replace(/\r\n/g, '\n') };
}

export async function shellOk(serial, cmd, opts = {}) {
  const r = await shell(serial, cmd, opts);
  if (r.code !== 0) {
    throw new Error(`device shell "${cmd}" exit ${r.code}: ${clip((r.stderr || r.stdout || '').trim(), 800)}`);
  }
  return r.out;
}

export async function getprop(serial, name) {
  const r = await shell(serial, `getprop ${name}`, { timeoutMs: 8000 });
  return r.out.trim();
}

export async function quickInfo(serial) {
  const [model, release, sdkInt, size, density] = await Promise.all([
    getprop(serial, 'ro.product.model'),
    getprop(serial, 'ro.build.version.release'),
    getprop(serial, 'ro.build.version.sdk'),
    shellOk(serial, 'wm size').catch(() => ''),
    shellOk(serial, 'wm density').catch(() => ''),
  ]);
  return {
    serial,
    model,
    androidVersion: release,
    apiLevel: Number(sdkInt) || undefined,
    resolution: (size.match(/(\d+x\d+)/) || [])[1],
    density: (density.match(/(\d+)/) || [])[1],
  };
}

export async function screencap(serial) {
  const r = await adb(['-s', serial, 'exec-out', 'screencap', '-p'], { timeoutMs: 30000 });
  const buf = r.stdoutBuf;
  if (!buf || buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) {
    throw new Error(`screencap returned invalid PNG (${buf ? buf.length : 0} bytes): ${clip(r.stderr, 300)}`);
  }
  return buf;
}

export function pngSize(buf) {
  try {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    return {};
  }
}

export async function logcatDump(serial, { lines = 300, tag, priority } = {}) {
  const parts = ['logcat', '-d', '-t', String(Math.min(lines, 5000))];
  if (tag) parts.push('-s', tag);
  if (priority) parts.push(`${priority.toUpperCase()}`.length ? `*:${priority.toUpperCase()}` : '');
  const filtered = parts.filter(Boolean);
  const r = await adb(['-s', serial, 'shell', ...filtered], { timeoutMs: 30000 });
  return r.stdout.replace(/\r\n/g, '\n');
}

export async function appInstall(serial, apkPath, { timeoutSec = 300 } = {}) {
  const r = await adb(['-s', serial, 'install', '-r', '-t', apkPath], { timeoutMs: timeoutSec * 1000 });
  const out = (r.stdout + r.stderr).replace(/\r\n/g, '\n');
  if (!/Success/i.test(out)) throw new Error(`install failed: ${clip(out, 1000)}`);
  return 'installed: ' + apkPath;
}

export async function appLaunch(serial, pkg) {
  // Resolve the launcher activity, then am start; fall back to monkey.
  const res = await shell(serial, `cmd package resolve-activity --brief ${pkg}`);
  const comp = res.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
  if (comp && /^[\w.]+\/[\w.$]+$/.test(comp) && !/resolve/i.test(comp)) {
    const start = await shell(serial, `am start -n ${comp}`);
    if (!/error|not found|exception/i.test(start.out)) return `launched ${pkg} (${comp})`;
  }
  const mk = await shell(serial, `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
  if (/No activities found|aborted/i.test(mk.out)) throw new Error(`cannot launch ${pkg}: ${clip(mk.out, 500)}`);
  return `launched ${pkg} (monkey)`;
}
