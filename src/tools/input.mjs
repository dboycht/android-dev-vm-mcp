// Touch / text / key input tools.
import { z } from 'zod';
import { resolveSerial, shellOk } from '../adb.mjs';
import { deviceQuote } from '../util.mjs';

const KEY_CODES = {
  home: 3, back: 4, call: 5, endcall: 6, dpad_up: 19, dpad_down: 20,
  dpad_left: 21, dpad_right: 22, dpad_center: 23, volume_up: 24, volume_down: 25,
  power: 26, camera: 27, tab: 61, page_up: 92, page_down: 93, del: 67, enter: 66,
  menu: 82, notifications: 83, search: 84, media_play_pause: 126, media_next: 87,
  media_previous: 88, app_switch: 187, move_home: 122, move_end: 123, mute: 164,
};

export const inputTools = [
  {
    name: 'android_tap',
    description: 'Tap the screen at pixel coordinates.',
    inputSchema: {
      x: z.number().int().describe('X in pixels.'),
      y: z.number().int().describe('Y in pixels.'),
      device: z.string().optional().describe('Device serial; defaults to the emulator.'),
    },
    handler: async ({ x, y, device }) => {
      const serial = await resolveSerial(device);
      await shellOk(serial, `input tap ${x} ${y}`);
      return `tapped (${x},${y})`;
    },
  },
  {
    name: 'android_swipe',
    description: 'Swipe/drag between two points (also: flick to scroll, or long-press by using same start/end with a long duration).',
    inputSchema: {
      x1: z.number().int(), y1: z.number().int(),
      x2: z.number().int(), y2: z.number().int(),
      durationMs: z.number().int().default(300).describe('Gesture duration; use 800+ for slow drags or long-press.'),
      device: z.string().optional().describe('Device serial; defaults to the emulator.'),
    },
    handler: async ({ x1, y1, x2, y2, durationMs, device }) => {
      const serial = await resolveSerial(device);
      await shellOk(serial, `input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`);
      return `swiped (${x1},${y1})->(${x2},${y2}) in ${durationMs}ms`;
    },
  },
  {
    name: 'android_text',
    description: 'Type text into the focused input field (single line; newlines are rejected — send android_key enter instead).',
    inputSchema: {
      text: z.string().min(1).max(500).describe('Text to type. Avoid ` and control characters.'),
      device: z.string().optional().describe('Device serial; defaults to the emulator.'),
    },
    handler: async ({ text, device }) => {
      if (/[\r\n]/.test(text)) throw new Error('text must be single-line — send android_key enter for newlines');
      const serial = await resolveSerial(device);
      await shellOk(serial, `input text ${deviceQuote(text)}`, { timeoutMs: 20000 });
      return `typed: "${text}"`;
    },
  },
  {
    name: 'android_key',
    description: 'Send a key event: name (back, home, enter, del, power, volume_up, volume_down, dpad_up/down/left/right/center, tab, menu, search, app_switch, ...) or a numeric keyevent code.',
    inputSchema: {
      key: z.string().min(1).describe('Key name or numeric code, e.g. `back` or `4`.'),
      device: z.string().optional().describe('Device serial; defaults to the emulator.'),
    },
    handler: async ({ key, device }) => {
      const serial = await resolveSerial(device);
      const code = KEY_CODES[key.toLowerCase()] ?? Number(key);
      if (!Number.isInteger(code)) {
        throw new Error(`unknown key "${key}". Known: ${Object.keys(KEY_CODES).join(', ')} or a numeric code`);
      }
      await shellOk(serial, `input keyevent ${code}`);
      return `keyevent ${code} (${key}) sent`;
    },
  },
];
