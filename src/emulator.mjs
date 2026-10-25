// Emulator lifecycle: acceleration pre-check, detached headless boot with
// boot-completed polling, AI-friendly post-boot setup, graceful shutdown.
import fs from 'node:fs';
import path from 'node:path';
import {
  AVD_NAME, AVD_DEVICE_PROFILE, AVDMANAGER_BAT, AVD_HOME, ADB_EXE, DATA_DIR, EMU_EXE, EMU_PORT,
  EMU_SERIAL, GPU_MODE, EMU_LOG_FILE, SYSTEM_IMAGE, fullEnv, imageParts,
} from './config.mjs';
import { run, ensureDir, spawnDetached, killTree, sleep, tailFile, log, clip } from './util.mjs';
import { listDevices, readRuntime, writeRuntime, readRuntimeSerial } from './adb.mjs';

// ---- AVD management -------------------------------------------------------

export function avdExists() {
  return fs.existsSync(path.join(AVD_HOME, AVD_NAME + '.ini')) &&
    fs.existsSync(path.join(AVD_HOME, AVD_NAME + '.avd', 'config.ini'));
}

export async function ensureAvd() {
  if (avdExists()) return { created: false, name: AVD_NAME };
  if (!fs.existsSync(AVDMANAGER_BAT)) {
    throw new Error('Android cmdline-tools not installed yet — run android_env_setup first.');
  }
  ensureDir(AVD_HOME);
  const base = ['create', 'avd', '--force', '--name', AVD_NAME, '--package', SYSTEM_IMAGE];
  let r = await run(AVDMANAGER_BAT, [...base, '--device', AVD_DEVICE_PROFILE], {
    timeoutMs: 120000, stdin: 'no\n', env: fullEnv(),
  });
  if (!avdExists()) {
    log(`avdmanager with device profile failed (${clip((r.stderr || r.stdout).trim(), 200)}), retrying generic`);
    r = await run(AVDMANAGER_BAT, base, { timeoutMs: 120000, stdin: 'no\n', env: fullEnv() });
  }
  if (!avdExists()) {
    log(`avdmanager failed (${clip((r.stderr || r.stdout).trim(), 200)}), writing AVD manually`);
    writeManualAvd();
  }
  if (!avdExists()) {
    throw new Error(`AVD creation failed: ${clip((r.stderr || r.stdout).trim(), 800)}`);
  }
  tweakAvdConfig();
  return { created: true, name: AVD_NAME };
}

// Fallback when avdmanager refuses our hand-installed image package: the
// emulator only needs these two text files, no package.xml validation.
function writeManualAvd() {
  const { api, tag, abi } = imageParts();
  const dir = path.join(AVD_HOME, AVD_NAME + '.avd');
  ensureDir(dir);
  const sysDirRel = `system-images\\${api}\\${tag}\\${abi}\\`;
  fs.writeFileSync(path.join(AVD_HOME, AVD_NAME + '.ini'), [
    'avd.ini.encoding=UTF-8',
    `path=${dir}`,
    `path.rel=avd\\${AVD_NAME}.avd`,
    `target=${api}`,
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'config.ini'), [
    'avd.ini.encoding=UTF-8',
    `image.sysdir.1=${sysDirRel}`,
    `image.androidVersion.api=${api.replace('android-', '')}`,
    `abi.type=${abi}`,
    `hw.cpu.arch=${abi}`,
    'hw.cpu.ncore=4',
    'hw.ramSize=3072',
    'hw.keyboard=yes',
    `tag.id=${tag}`,
    `tag.display=${tag === 'google_apis' ? 'Google APIs' : tag}`,
    'PlayStore.enabled=false',
    'hw.lcd.width=1080',
    'hw.lcd.height=2400',
    'hw.lcd.density=420',
    'hw.lcd.depth=16',
    'disk.dataPartition.size=6G',
    'hw.gpu.enabled=yes',
    `hw.gpu.mode=${GPU_MODE}`,
    'hw.audioInput=no',
    'hw.device.name=pixel_7',
    'hw.device.manufacturer=Google',
  ].join('\n') + '\n', 'utf8');
}

function tweakAvdConfig() {
  const p = path.join(AVD_HOME, AVD_NAME + '.avd', 'config.ini');
  let s = fs.readFileSync(p, 'utf8');
  const set = (k, v) => {
    const re = new RegExp(`^${k}=.*$`, 'm');
    s = re.test(s) ? s.replace(re, `${k}=${v}`) : s.replace(/\s*$/, '\n') + `${k}=${v}\n`;
  };
  set('hw.ramSize', '3072');
  set('hw.keyboard', 'yes');
  fs.writeFileSync(p, s, 'utf8');
}

// ---- state ----------------------------------------------------------------

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export async function emulatorRunning() {
  try {
    return (await listDevices()).some((d) => d.serial === (readRuntimeSerial() || EMU_SERIAL));
  } catch {
    return false;
  }
}

// Ask the emulator console which AVD is running on a port; null if none.
// Never assume "port busy" means OUR emulator is there — another emulator
// (e.g. Android Studio's) may hold the default port 5554.
export async function avdNameOnPort(port) {
  try {
    const r = await run(ADB_EXE, ['-s', `emulator-${port}`, 'emu', 'avd', 'name'], {
      timeoutMs: 6000, env: fullEnv(),
    });
    const line = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s !== 'OK')[0];
    return line || null;
  } catch {
    return null;
  }
}

export async function bootCompleted(serial) {
  try {
    const r = await run(ADB_EXE, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], {
      timeoutMs: 8000, env: fullEnv(),
    });
    return r.stdout.trim() === '1';
  } catch {
    return false;
  }
}

// Without the emulator binary we can't run -accel-check; this pre-check only
// asks whether the Windows Hypervisor Platform service exists.
export async function accelPrecheck() {
  const r = await run('sc.exe', ['query', 'vmcompute'], { timeoutMs: 10000 });
  const out = (r.stdout + r.stderr).replace(/\r\n/g, '\n');
  return { hypervisorService: r.code === 0, raw: clip(out, 400) };
}

export async function accelCheck() {
  if (!fs.existsSync(EMU_EXE)) {
    return { checked: false, ok: false, message: 'emulator not installed yet (run android_env_setup first)' };
  }
  const r = await run(EMU_EXE, ['-accel-check'], { timeoutMs: 60000, env: fullEnv() });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  return { checked: true, ok: r.code === 0, exitCode: r.code, message: out.slice(0, 1500) };
}

// ---- boot / shutdown ------------------------------------------------------

// Console ports come in pairs (console, adb); step by 2. The first entry is
// the default port, which unrelated emulators love to occupy.
const PORT_OFFSETS = [0, 2, 4, 6, 8, 10];

export async function boot(opts = {}) {
  const { wipe = false, noSnapshot = false, timeoutSec = 600, postBoot = true } = opts;
  if (!fs.existsSync(EMU_EXE)) throw new Error('Emulator not installed. Run android_env_setup first.');
  await ensureAvd();

  ensureDir(DATA_DIR);
  const t0 = Date.now();

  // Find OUR avd if it is already running on any candidate port; else take the
  // first free port. Attach only when the running AVD name matches ours.
  let serial = null;
  let attached = false;
  let spawnPort = null;
  for (const off of PORT_OFFSETS) {
    const p = EMU_PORT + off;
    const name = await avdNameOnPort(p);
    if (name === AVD_NAME) {
      serial = `emulator-${p}`;
      attached = true;
      break;
    }
    if (name == null && spawnPort == null) spawnPort = p;
  }

  if (serial) {
    writeRuntime({ serial, port: Number(serial.split('-')[1]), avd: AVD_NAME, pid: readRuntime()?.pid ?? null });
    log(`attaching to already-running ${serial} (${AVD_NAME})`);
  } else {
    const port = spawnPort ?? EMU_PORT;
    const args = [
      '-avd', AVD_NAME,
      '-port', String(port),
      '-no-window', '-no-audio', '-no-boot-anim',
      '-gpu', GPU_MODE,
    ];
    if (wipe) args.push('-wipe-data');
    if (noSnapshot) args.push('-no-snapshot');
    const pid = spawnDetached(EMU_EXE, args, { env: fullEnv(), logFile: EMU_LOG_FILE });
    serial = `emulator-${port}`;
    writeRuntime({ serial, port, avd: AVD_NAME, pid });
    log(`emulator spawned pid=${pid} serial=${serial} args=${args.join(' ')}`);
  }

  const deadline = Date.now() + timeoutSec * 1000;
  let appeared = attached;
  while (Date.now() < deadline) {
    try {
      appeared = (await listDevices()).some((d) => d.serial === serial) || appeared;
    } catch {}
    if (appeared && (await bootCompleted(serial))) {
      if (postBoot) await applyPostBootSetup(serial).catch((e) => log('postBoot partial failure:', e.message));
      return { serial, attached, bootSecs: Math.round((Date.now() - t0) / 1000) };
    }
    await sleep(2000);
  }
  throw new Error(
    `Emulator did not finish booting within ${timeoutSec}s.\nEmulator log tail:\n${tailFile(EMU_LOG_FILE, 40)}`,
  );
}

// Stable test surface: no animations, screen stays on.
export async function applyPostBootSetup(serial) {
  const puts = [
    ['global', 'window_animation_scale', '0'],
    ['global', 'transition_animation_scale', '0'],
    ['global', 'animator_duration_scale', '0'],
    ['system', 'screen_off_timeout', '1800000'],
  ];
  for (const [ns, key, val] of puts) {
    await run(ADB_EXE, ['-s', serial, 'shell', 'settings', 'put', ns, key, val], {
      timeoutMs: 10000, env: fullEnv(),
    });
  }
  await run(ADB_EXE, ['-s', serial, 'shell', 'svc', 'power', 'stayon', 'true'], {
    timeoutMs: 10000, env: fullEnv(),
  });
}

export async function shutdown() {
  const rt = readRuntime();
  const port = rt?.port ?? EMU_PORT;
  const serial = rt?.serial ?? EMU_SERIAL;
  const name = await avdNameOnPort(port);
  if (name && name !== AVD_NAME) {
    return { stopped: false, message: `emulator-${port} is running AVD "${name}", not ours ("${AVD_NAME}") — left untouched` };
  }
  const result = { stopped: true, graceful: false, forced: false };
  try {
    const r = await run(ADB_EXE, ['-s', serial, 'emu', 'kill'], { timeoutMs: 15000, env: fullEnv() });
    result.graceful = r.code === 0;
  } catch {}
  const t0 = Date.now();
  while (Date.now() < t0 + 15000) {
    if (name == null || !pidAlive(rt?.pid)) {
      if (!(await emulatorRunning())) break;
    } else if (!pidAlive(rt?.pid)) break;
    await sleep(1000);
  }
  if (rt?.pid && pidAlive(rt.pid)) {
    killTree(rt.pid);
    result.forced = true;
  }
  return result;
}
