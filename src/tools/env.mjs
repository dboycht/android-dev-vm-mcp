// Environment lifecycle tools: status, one-shot SDK+AVD setup, boot, shutdown.
import fs from 'node:fs';
import { z } from 'zod';
import { ADB_EXE, SDK_DIR, SYSTEM_IMAGE, AVD_NAME, EMU_SERIAL, GPU_MODE } from '../config.mjs';
import { log } from '../util.mjs';
import { sdkStatus, sdkReady, ensureSdk } from '../sdk.mjs';
import { avdExists, ensureAvd, boot, shutdown, accelCheck, accelPrecheck, bootCompleted } from '../emulator.mjs';
import { listDevices, readRuntimeSerial } from '../adb.mjs';

async function envStatus() {
  const sdk = sdkStatus();
  const avd = { name: AVD_NAME, created: avdExists() };
  const accel = await accelCheck();
  let devices = [];
  if (sdk.adb) {
    devices = await listDevices().catch((e) => [{ error: e.message }]);
  }
  const ourSerial = readRuntimeSerial() || EMU_SERIAL;
  const running = devices.some((d) => d.serial === ourSerial);
  const booted = running && (await bootCompleted(ourSerial));
  const nextSteps = [];
  if (!sdkReady()) {
    nextSteps.push('android_env_setup — download the Android SDK (~2.5 GB, one time, 5-40 min depending on network). Prefer running `node cli.mjs setup` in a terminal.');
    const pre = await accelPrecheck();
    if (sdk.emulator && !accel.ok) { /* accelCheck already reported */ }
    if (!pre.hypervisorService) {
      nextSteps.push('WARNING: Windows Hypervisor Platform service (vmcompute) not found — emulator will be unusably slow. Fix BEFORE downloading: run in an admin terminal `DISM /Online /Enable-Feature /All /FeatureName:HypervisorPlatform` and reboot.');
    }
  } else if (!avd.created) {
    nextSteps.push('android_emulator_boot — will create the AVD automatically, then boot headless (first boot 1-3 min).');
  } else if (!running) {
    nextSteps.push('android_emulator_boot — start the headless emulator.');
  } else if (!booted) {
    nextSteps.push('Emulator port is up but still booting — wait, or call android_emulator_boot again.');
  } else {
    nextSteps.push('Ready. Typical flow: android_ui_dump -> android_ui_tap / android_tap -> android_screenshot -> android_logcat. Use android_shell for anything else.');
  }
  return { sdk, avd, acceleration: accel, emulator: { running, booted, serial: ourSerial, gpu: GPU_MODE }, systemImage: SYSTEM_IMAGE, devices, nextSteps };
}

export const envTools = [
  {
    name: 'android_env_status',
    description: 'Report the state of the local Android dev VM: SDK installed? AVD created? hardware acceleration available? emulator running/booted? connected devices? Includes concrete next-step suggestions.',
    inputSchema: {},
    handler: envStatus,
  },
  {
    name: 'android_env_setup',
    description: 'One-time environment bootstrap: downloads the Android SDK cmdline-tools, platform-tools (adb), emulator and a Google APIs system image (~2.5 GB total) into the project folder, accepts licenses, then creates the dev AVD. Idempotent. May take 5-40 minutes — prefer running `node cli.mjs setup` via a terminal/shell tool for progress visibility.',
    inputSchema: {},
    handler: async () => {
      const sdkRes = await ensureSdk({
        onProgress: (p) => {
          if (p.pct != null) log(`setup ${p.stage}: ${p.pct}% (${Math.round(p.got / 1048576)} MB)`);
        },
      });
      const avdRes = await ensureAvd();
      const accel = await accelCheck();
      return {
        sdk: sdkRes, avd: avdRes, acceleration: accel,
        note: accel.ok ? 'acceleration OK' : 'WARNING: no hardware acceleration — emulator will be extremely slow. Enable Windows Hypervisor Platform (admin): DISM /Online /Enable-Feature /All /FeatureName:HypervisorPlatform, then reboot.',
      };
    },
  },
  {
    name: 'android_emulator_boot',
    description: 'Start the headless Android emulator (no window) and wait until boot completes. Creates the AVD first if missing. Auto-disables animations and keeps the screen on after boot. First boot 1-3 min; later boots faster via snapshot.',
    inputSchema: {
      wipe: z.boolean().default(false).describe('Wipe user data and cold-boot a fresh device (use when the VM is in a bad state).'),
      noSnapshot: z.boolean().default(false).describe('Skip snapshot save/restore (forces a clean cold boot this time).'),
      timeoutSec: z.number().int().default(600).describe('Boot wait timeout in seconds.'),
    },
    handler: (a) => boot(a),
  },
  {
    name: 'android_emulator_shutdown',
    description: 'Shut down the emulator (graceful via console, force-kill as fallback).',
    inputSchema: {},
    handler: () => shutdown(),
  },
];
