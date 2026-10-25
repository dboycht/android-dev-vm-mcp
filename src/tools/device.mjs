// Device info / shell / file transfer / screenshot tools.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DATA_DIR } from '../config.mjs';
import { clip, ensureDir } from '../util.mjs';
import { resolveSerial, listDevices, quickInfo, shell, screencap, pngSize } from '../adb.mjs';
import { screenshotPath } from '../ui.mjs';

export const deviceTools = [
  {
    name: 'android_device_list',
    description: 'List connected Android devices/emulators (serial, state, model).',
    inputSchema: {},
    handler: async () => ({ devices: await listDevices() }),
  },
  {
    name: 'android_device_info',
    description: 'Device identity: model, Android version, API level, screen resolution and density.',
    inputSchema: {
      device: z.string().optional().describe('Device serial; defaults to the emulator.'),
    },
    handler: async ({ device }) => quickInfo(await resolveSerial(device)),
  },
  {
    name: 'android_shell',
    description: 'Run an arbitrary shell command on the device (toybox sh). Escape hatch for anything without a dedicated tool: dumpsys, ps, ls, cat, settings, cmd, am, pm, getprop...',
    inputSchema: {
      command: z.string().min(1).describe('Shell command, e.g. `dumpsys battery` or `ps -A | grep chrome`.'),
      timeoutSec: z.number().int().default(30).describe('Command timeout in seconds.'),
      device: z.string().optional().describe('Device serial; defaults to the emulator.'),
    },
    handler: async ({ command, timeoutSec, device }) => {
      const serial = await resolveSerial(device);
      const r = await shell(serial, command, { timeoutMs: timeoutSec * 1000 });
      let text = `exit=${r.code}\n${clip(r.out, 40000)}`;
      if (r.stderr.trim()) text += `\n[stderr]\n${clip(r.stderr.trim(), 4000)}`;
      return text;
    },
  },
  {
    name: 'android_push',
    description: 'Copy a file from this computer onto the device.',
    inputSchema: {
      local: z.string().min(1).describe('Absolute path of the local file.'),
      remote: z.string().min(1).describe('Destination path on device, e.g. /sdcard/Download/app.apk.'),
      device: z.string().optional().describe('Device serial; defaults to the emulator.'),
    },
    handler: async ({ local, remote, device }) => {
      if (!fs.existsSync(local)) throw new Error(`local file not found: ${local}`);
      const serial = await resolveSerial(device);
      const { adbOk } = await import('../adb.mjs');
      await adbOk(['-s', serial, 'push', local, remote], { timeoutMs: 300000 });
      return `pushed ${local} -> ${remote}`;
    },
  },
  {
    name: 'android_pull',
    description: 'Copy a file from the device onto this computer (default destination: project data/pulled/).',
    inputSchema: {
      remote: z.string().min(1).describe('Path on device, e.g. /sdcard/Download/some.png.'),
      local: z.string().optional().describe('Absolute local destination path (file or dir).'),
      device: z.string().optional().describe('Device serial; defaults to the emulator.'),
    },
    handler: async ({ remote, local, device }) => {
      const serial = await resolveSerial(device);
      ensureDir(path.join(DATA_DIR, 'pulled'));
      const dest = local || path.join(DATA_DIR, 'pulled', path.basename(remote));
      const { adbOk } = await import('../adb.mjs');
      await adbOk(['-s', serial, 'pull', remote, dest], { timeoutMs: 300000 });
      return `pulled ${remote} -> ${dest}`;
    },
  },
  {
    name: 'android_screenshot',
    description: 'Capture the current screen. Returns the PNG as an image (viewable by multimodal clients) and saves it under the project data/screenshots/ folder (or a custom absolute path).',
    inputSchema: {
      savePath: z.string().optional().describe('Optional custom absolute path for the PNG, or a bare filename saved into data/screenshots/.'),
      device: z.string().optional().describe('Device serial; defaults to the emulator.'),
    },
    handler: async ({ savePath, device }) => {
      const serial = await resolveSerial(device);
      const buf = await screencap(serial);
      const p = screenshotPath(savePath);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buf);
      const { width, height } = pngSize(buf);
      return [
        { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: `saved: ${p} (${width}x${height}, ${Math.round(buf.length / 1024)} KB)` },
      ];
    },
  },
];
