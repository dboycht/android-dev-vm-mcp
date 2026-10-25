// Debugging tools: logcat dump/clear, system settings get/put/delete.
import { z } from 'zod';
import { resolveSerial, logcatDump, shellOk } from '../adb.mjs';
import { clip } from '../util.mjs';

const NAMESPACES = ['system', 'secure', 'global'];

export const debugTools = [
  {
    name: 'android_logcat',
    description: 'Read recent device log (logcat, dump mode — not a live stream). Combine tag and priority to narrow down, e.g. tag=ActivityTaskManager priority=I.',
    inputSchema: {
      lines: z.number().int().default(300).describe('Max lines to return (tail).'),
      tag: z.string().optional().describe('Only logs for this tag (-s TAG).'),
      priority: z.enum(['V', 'D', 'I', 'W', 'E', 'F']).optional().describe('Minimum priority filter, e.g. W for warnings+errors.'),
      device: z.string().optional().describe('Device serial; defaults to the emulator.'),
    },
    handler: async ({ lines, tag, priority, device }) => {
      const serial = await resolveSerial(device);
      const out = await logcatDump(serial, { lines, tag, priority });
      if (!out.trim()) return '(logcat empty for this filter)';
      return clip(out, 60000);
    },
  },
  {
    name: 'android_logcat_clear',
    description: 'Clear the device log buffer (logcat -c) so subsequent reads only show fresh logs.',
    inputSchema: {
      device: z.string().optional().describe('Device serial; defaults to the emulator.'),
    },
    handler: async ({ device }) => {
      const serial = await resolveSerial(device);
      await shellOk(serial, 'logcat -c');
      return 'logcat cleared';
    },
  },
  {
    name: 'android_settings',
    description: 'Get/put/delete Android system settings (settings put/get/delete). Useful for test fixtures: stay-awake, animations, location mode, global http proxy, etc.',
    inputSchema: {
      namespace: z.enum(['system', 'secure', 'global']),
      key: z.string().min(1).describe('Setting key, e.g. screen_off_timeout.'),
      value: z.string().optional().describe('Omit to read; provide to write. Pass op=delete to remove.'),
      op: z.enum(['get', 'put', 'delete']).optional().describe('Defaults to put when value given, get otherwise.'),
      device: z.string().optional().describe('Device serial; defaults to the emulator.'),
    },
    handler: async ({ namespace, key, value, op, device }) => {
      const serial = await resolveSerial(device);
      const verb = op || (value != null ? 'put' : 'get');
      if (verb === 'put') {
        if (value == null) throw new Error('put requires value');
        await shellOk(serial, `settings put ${namespace} ${key} ${value}`);
        return `${namespace}/${key} = ${value}`;
      }
      if (verb === 'delete') {
        await shellOk(serial, `settings delete ${namespace} ${key}`);
        return `${namespace}/${key} deleted`;
      }
      const r = await shellOk(serial, `settings get ${namespace} ${key}`);
      return clip(r.trim() || '(null)', 500);
    },
  },
];
