// One-command Android SDK bootstrap, fully self-contained inside <project>/sdk:
// download cmdline-tools zip -> sdkmanager --licenses -> install
// platform-tools + emulator -> system image (fast path first). Idempotent.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  SDK_DIR, DATA_DIR, ADB_EXE, EMU_EXE, SDKMANAGER_BAT, AVDMANAGER_BAT, SYSTEM_IMAGE, fullEnv, imageParts,
} from './config.mjs';
import { run, ensureDir, log, clip, downloadParallel as download, unzip } from './util.mjs';

const REPO_BASE = 'https://dl.google.com/android/repository/';
const CMDLINE_TOOLS_FALLBACKS = [13114758, 12266719, 11076708].map((n) => `${REPO_BASE}commandlinetools-win-${n}_latest.zip`);

export function sdkStatus() {
  const { api, tag, abi } = imageParts();
  return {
    sdkDir: SDK_DIR,
    cmdlineTools: fs.existsSync(SDKMANAGER_BAT),
    adb: fs.existsSync(ADB_EXE),
    emulator: fs.existsSync(EMU_EXE),
    systemImage: fs.existsSync(path.join(SDK_DIR, 'system-images', api, tag, abi, 'system.img')),
  };
}

export function imageInstalled() {
  const { api, tag, abi } = imageParts();
  return fs.existsSync(path.join(SDK_DIR, 'system-images', api, tag, abi, 'system.img'));
}

export function sdkReady() {
  const s = sdkStatus();
  return s.cmdlineTools && s.adb && s.emulator && s.systemImage;
}

// The "_latest" zip name carries a build number that changes over time, so
// scrape it from Google's repository manifest; fall back to known builds.
async function fetchCmdlineToolsUrl() {
  for (const xmlUrl of [
    'https://dl.google.com/android/repository/repository2-3.xml',
    'https://dl.google.com/android/repository/repository2-1.xml',
  ]) {
    try {
      const res = await fetch(xmlUrl);
      if (!res.ok) continue;
      const m = (await res.text()).match(/commandlinetools-win-(\d+)_latest\.zip/);
      if (m) return `https://dl.google.com/android/repository/${m[0]}`;
    } catch {}
  }
  return null;
}

// The new "Android CLI" (cmdline-tools 22+) downloads its package catalog as a
// protobuf blob into sdk/.sdk/objects — the only public place where system
// image zip URLs still live (they were removed from repository2-*.xml).
// Extract zip URL + sha1 for our image from that cache.
async function findImageInCatalog() {
  const { api, tag, abi } = imageParts();
  const objectsDir = path.join(SDK_DIR, '.sdk', 'objects');
  if (!fs.existsSync(objectsDir)) return null;
  const key = `system-images/${api}/${tag}/${abi}`;
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  })(objectsDir);
  for (const f of files) {
    const s = fs.readFileSync(f).toString('latin1');
    const i = s.indexOf(key);
    if (i < 0) continue;
    const seg = s.slice(i, i + 600);
    const zipMatch = seg.match(/sys-img\/[A-Za-z0-9._/-]+\.zip/);
    if (!zipMatch) continue;
    const sha1 = (seg.slice(0, zipMatch.index).match(/[0-9a-f]{40}/) || [])[0];
    return { zipUrl: REPO_BASE + zipMatch[0], sha1: sha1 || null };
  }
  return null;
}

function packageXml({ api, tag, abi }, revision) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sdk:repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/03" xmlns:common="http://schemas.android.com/repository/android/common/02" xmlns:sdk-common="http://schemas.android.com/sdk/android/repo/common/03" xmlns:sdk-sys-img="http://schemas.android.com/sdk/android/repo/sys-img2/03" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><localPackage path="system-images;${api};${tag};${abi}" obsolete="false"><type-details xsi:type="sdk-sys-img:sysImgDetailsType"><api-level>${api.replace('android-', '')}</api-level><tag><id>${tag}</id><display>${tag === 'google_apis' ? 'Google APIs' : tag}</display></tag><abi>${abi}</abi></type-details><revision><major>${revision}</major></revision><display-name>System Image ${api} ${tag} ${abi}</display-name><dependencies><dependency path="emulator"><min-revision><major>31</major></min-revision></dependency></dependencies></localPackage></sdk:repository>`;
}

// Fast system-image install: direct zip download via Node (measured ~10x faster
// than the Android CLI's downloader on this network), sha1-verified, extracted
// into sdk/system-images/... with a hand-written package.xml so avdmanager
// accepts the package.
export async function fastInstallSystemImage({ onProgress } = {}) {
  const { api, tag, abi } = imageParts();
  const target = path.join(SDK_DIR, 'system-images', api, tag, abi);
  const found = await findImageInCatalog();
  if (!found) throw new Error('image entry not found in Android CLI catalog cache');
  log(`fast path: ${found.zipUrl}`);
  const zipPath = path.join(DATA_DIR, 'sys-img.zip');
  await download(found.zipUrl, zipPath, { onProgress });
  if (found.sha1) {
    const h = crypto.createHash('sha1');
    for await (const chunk of fs.createReadStream(zipPath)) h.update(chunk);
    const digest = h.digest('hex');
    if (digest !== found.sha1) throw new Error(`sha1 mismatch: got ${digest}, expected ${found.sha1}`);
    log('sha1 verified');
  }
  const tmpRoot = path.join(DATA_DIR, '_sysimg-tmp');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  await unzip(zipPath, tmpRoot);
  let imgDir = null;
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f === 'system.img') imgDir = d;
    }
  })(tmpRoot);
  if (!imgDir) throw new Error('no system.img in downloaded zip');
  const rel = path.relative(tmpRoot, imgDir).split(path.sep);
  fs.mkdirSync(path.join(SDK_DIR, 'system-images'), { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  if (rel.length >= 3 && rel.slice(-3).join('/') === `${api}/${tag}/${abi}`) {
    fs.renameSync(path.join(tmpRoot, rel.slice(-3)[0]), path.join(SDK_DIR, 'system-images', api));
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(imgDir, target);
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  if (!fs.existsSync(path.join(target, 'system.img'))) throw new Error('image extraction did not land correctly');
  // package.xml (informational for sdkmanager; required by avdmanager)
  const propFile = path.join(target, 'source.properties');
  const props = fs.existsSync(propFile) ? fs.readFileSync(propFile, 'utf8') : '';
  const revMatch = (props.match(/Pkg\.Revision=(\d+)/) || [])[1];
  fs.writeFileSync(path.join(target, 'package.xml'), packageXml({ api, tag, abi }, revMatch || '1'), 'utf8');
  return { done: true, zipUrl: found.zipUrl };
}

export async function ensureSdk({ onProgress } = {}) {
  if (sdkReady()) return { done: false, message: 'SDK already installed, skipped.' };

  ensureDir(SDK_DIR);
  ensureDir(DATA_DIR);

  if (!fs.existsSync(SDKMANAGER_BAT)) {
    let url = await fetchCmdlineToolsUrl();
    if (!url) url = CMDLINE_TOOLS_FALLBACKS[0];
    const zip = path.join(DATA_DIR, 'cmdline-tools.zip');
    log(`downloading ${url} (~150 MB)...`);
    const { bytes } = await download(url, zip, {
      onProgress: onProgress
        ? (p) => onProgress({ stage: 'cmdline-tools', ...p })
        : undefined,
    });
    if (!fs.existsSync(zip)) throw new Error(`download failed: ${url}`);
    const tmp = path.join(SDK_DIR, '_clt-tmp');
    await unzip(zip, tmp);
    const extracted = path.join(tmp, 'cmdline-tools');
    const target = path.join(SDK_DIR, 'cmdline-tools', 'latest');
    ensureDir(path.dirname(target));
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(extracted, target);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
    if (!fs.existsSync(SDKMANAGER_BAT)) throw new Error('cmdline-tools extracted but sdkmanager.bat not found');
    log('cmdline-tools installed');
  }

  // Accept licenses non-interactively (feed "y" lines to stdin).
  const lic = await run(SDKMANAGER_BAT, ['--sdk_root=' + SDK_DIR, '--licenses'], {
    timeoutMs: 300000,
    stdin: 'y\n'.repeat(300),
    env: fullEnv(),
  });
  log(`licenses accepted (exit ${lic.code})`);

  const packages = ['platform-tools', 'emulator'];
  let lastLog = 0;
  const r = await run(SDKMANAGER_BAT, ['--sdk_root=' + SDK_DIR, ...packages], {
    timeoutMs: 30 * 60000,
    stdin: 'y\n'.repeat(100),
    env: fullEnv(),
    onLine: (line) => {
      const now = Date.now();
      if (now - lastLog > 30000) {
        lastLog = now;
        log(`sdkmanager: ...${clip(line.trim(), 120)}`);
      }
      if (onProgress) onProgress({ stage: 'sdkmanager', line: line.trim() });
    },
  });
  if (r.code !== 0) {
    throw new Error(`sdkmanager install failed (exit ${r.code}${r.error ? `, ${clip(r.error, 200)}` : ''}):\n${clip(((r.stderr || '') + '\n' + (r.stdout || '')).trim().slice(-2000), 1500)}`);
  }
  if (!fs.existsSync(ADB_EXE) || !fs.existsSync(EMU_EXE)) {
    throw new Error('platform-tools/emulator missing after install');
  }

  // System image: fast direct download first (the Android CLI's own downloader
  // is heavily throttled on some networks), sdkmanager as slow fallback.
  let fast = null;
  if (!imageInstalled()) {
    try {
      fast = await fastInstallSystemImage({
        onProgress: onProgress ? (p) => onProgress({ stage: 'system-image', ...p }) : undefined,
      });
    } catch (e) {
      log('fast image install failed, falling back to sdkmanager:', e.message);
    }
    if (!imageInstalled()) {
      log('falling back to slow sdkmanager download for system image...');
      const r2 = await run(SDKMANAGER_BAT, ['--sdk_root=' + SDK_DIR, SYSTEM_IMAGE], {
        timeoutMs: 90 * 60000,
        stdin: 'y\n'.repeat(100),
        env: fullEnv(),
        onLine: (line) => {
          const now = Date.now();
          if (now - lastLog > 60000) {
            lastLog = now;
            log(`sdkmanager(image): ...${clip(line.trim(), 120)}`);
          }
        },
      });
      if (r2.code !== 0) {
        throw new Error(`system image install failed (exit ${r2.code}):\n${clip(((r2.stderr || '') + '\n' + (r2.stdout || '')).trim().slice(-2000), 1500)}`);
      }
    }
  }

  if (!sdkReady()) {
    const s = sdkStatus();
    throw new Error(`SDK install finished but components missing: ${JSON.stringify(s)}`);
  }
  return { done: true, packages: [...packages, SYSTEM_IMAGE], fastPath: fast?.done };
}
