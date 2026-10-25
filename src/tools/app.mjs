// App management tools: list / install / uninstall / launch / stop / clear.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveSerial, shellOk, shell, appInstall, appLaunch } from '../adb.mjs';
import { clip } from '../util.mjs';

export const appTools = [
  {
    name: 'android_app_list',
    description: 'List installed packages. thirdPartyOnly=true shows only user-installed apps.',
    inputSchema: {
      thirdPartyOnly: z.boolean().default(false).describe('Only third-party (-3) packages.'),
      device: z.string().optional().describe('Device serial; defaults to the emulator.'),
    },
    handler: async ({ thirdPartyOnly, device }) => {
      const serial = await resolveSerial(device);
      const out = await shellOk(serial, `pm list packages${thirdPartyOnly ? ' -3' : ''}`);
      const pkgs = out.split(/\r?\n/).map((l) => l.replace(/^package:/, '').trim()).filter(Boolean).sort();
      return clip(`(${pkgs.length} packages)\n` + pkgs.join('\n'), 30000);
    },
  },
  {
    name: 'android_app_install',
    description: 'Install an APK from this computer (adb install -r -t).',
    inputSchema: {
      apkPath: z.string().min(1).describe('Absolute path to the .apk file on this computer.'),
      device: z.string().optional().describe('Device serial; defaults to the emulator.'),
    },
    handler: async ({ apkPath, device }) => {
      if (!fs.existsSync(apkPath)) throw new Error(`APK not found: ${apkPath}`);
      const serial = await resolveSerial(device);
      return appInstall(serial, path.resolve(apkPath));
    },
  },
  {
    name: 'android_app_uninstall',
    description: 'Uninstall a package.',
    inputSchema: {
      package: z.string().min(1).describe('Package name, e.g. com.example.app.'),
      device: z.string().optional().describe('Device serial; defaults to the emulator.'),
    },
    handler: async ({ package: pkg, device }) => {
      const serial = await resolveSerial(device);
      const { adbOk } = await import('../adb.mjs');
      const r = await adbOk(['-s', serial, 'uninstall', pkg], { timeoutMs: 60000 });
      return clip(r.stdout.trim(), 300);
    },
  },
  {
    name: 'android_app_launch',
    description: 'Launch an app by package name (resolves its launcher activity).',
    inputSchema: {
      package: z.string().min(1).describe('Package name, e.g. com.android.settings.'),
      device: z.string().optional().describe('Device serial; defaults to the emulator.'),
    },
    handler: async ({ package: pkg, device }) => {
      const serial = await resolveSerial(device);
      return appLaunch(serial, pkg);
    },
  },
  {
    name: 'android_app_stop',
    description: 'Force-stop an app.',
    inputSchema: {
      package: z.string().min(1).describe('Package name.'),
      device: z.string().optional().describe('Device serial; defaults to the emulator.'),
    },
    handler: async ({ package: pkg, device }) => {
      const serial = await resolveSerial(device);
      await shellOk(serial, `am force-stop ${pkg}`);
      return `force-stopped ${pkg}`;
    },
  },
  {
    name: 'android_app_clear',
    description: 'Clear all app data (pm clear) — resets the app to first-run state.',
    inputSchema: {
      package: z.string().min(1).describe('Package name.'),
      device: z.string().optional().describe('Device serial; defaults to the emulator.'),
    },
    handler: async ({ package: pkg, device }) => {
      const serial = await resolveSerial(device);
      const out = await shellOk(serial, `pm clear ${pkg}`);
      return clip(out.trim(), 300);
    },
  },
];
