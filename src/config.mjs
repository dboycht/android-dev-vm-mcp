// All paths resolve relative to the project folder itself, so the whole
// environment (SDK, AVD, runtime data) lives inside the project directory:
// delete the folder = clean uninstall. Environment variables can override
// AVD name / port / system image without touching code.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // <root>/src
export const PROJECT_ROOT = path.resolve(here, '..');

export const DATA_DIR = path.join(PROJECT_ROOT, 'data');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const SHOTS_DIR = path.join(DATA_DIR, 'screenshots');
export const LOG_FILE = path.join(DATA_DIR, 'aivm.log');
export const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');
export const EMU_LOG_FILE = path.join(DATA_DIR, 'emulator.log');

// Self-contained SDK + AVD locations (gitignored)
export const SDK_DIR = path.join(PROJECT_ROOT, 'sdk');
export const AVD_HOME = path.join(PROJECT_ROOT, 'avd');
export const ANDROID_USER_HOME = path.join(PROJECT_ROOT, '.android-home');

export const ADB_EXE = path.join(SDK_DIR, 'platform-tools', 'adb.exe');
export const EMU_EXE = path.join(SDK_DIR, 'emulator', 'emulator.exe');
export const SDKMANAGER_BAT = path.join(SDK_DIR, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat');
export const AVDMANAGER_BAT = path.join(SDK_DIR, 'cmdline-tools', 'latest', 'bin', 'avdmanager.bat');

export const AVD_NAME = process.env.AIVM_AVD_NAME || 'aivm';
export const EMU_PORT = Number(process.env.AIVM_PORT || 5554);
export const EMU_SERIAL = `emulator-${EMU_PORT}`;
export const SYSTEM_IMAGE = process.env.AIVM_SYSTEM_IMAGE || 'system-images;android-35;google_apis;x86_64';
export const AVD_DEVICE_PROFILE = process.env.AIVM_DEVICE_PROFILE || 'pixel_7';
export const GPU_MODE = process.env.AIVM_GPU || 'swiftshader_indirect';

// Env passed to every adb / emulator / sdkmanager child so that SDK, AVD and
// adb keys all stay inside the project folder.
export const ANDROID_ENV = {
  ANDROID_SDK_ROOT: SDK_DIR,
  ANDROID_AVD_HOME: AVD_HOME,
  ANDROID_USER_HOME: ANDROID_USER_HOME,
  ANDROID_PREFS_ROOT: ANDROID_USER_HOME,
};

export function fullEnv(extra = {}) {
  return { ...process.env, ...ANDROID_ENV, ...extra };
}

// "system-images;android-35;google_apis;x86_64" -> { api, tag, abi }
export function imageParts(name = SYSTEM_IMAGE) {
  const parts = name.split(';');
  return { api: parts[1], tag: parts[2], abi: parts[3] };
}

export function pkgVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}
