// UI understanding: dump the view hierarchy as an indexed tree, and tap by
// index / text / resource-id / content-desc without coordinate math.
import { z } from 'zod';
import { resolveSerial, shellOk } from '../adb.mjs';
import { centerOf, freshDump, dumpFromCache, findNodes, formatTree, visibleTexts, dumpUiFlat } from '../ui.mjs';
import { clip } from '../util.mjs';

export const uiTools = [
  {
    name: 'android_ui_dump',
    description: 'Dump the current screen UI hierarchy (uiautomator) as a compact indexed tree: class, text, content-desc, resource-id, bounds and #index per node. Use #index with android_ui_tap; use bounds centers with android_tap.',
    inputSchema: {
      maxLines: z.number().int().default(400).describe('Max lines of tree output.'),
      device: z.string().optional().describe('Device serial; defaults to the emulator.'),
    },
    handler: async ({ maxLines, device }) => {
      const serial = await resolveSerial(device);
      const flat = await freshDump(serial);
      if (!flat.length) return '(empty UI hierarchy — screen may be transitioning; retry in a second)';
      return `${formatTree(flat, maxLines)}\n\n[${flat.length} nodes; tap any node with android_ui_tap {"index": N}, indices stay valid for ~2 min]`;
    },
  },
  {
    name: 'android_ui_tap',
    description: 'Tap a UI element without coordinates: by #index from the last android_ui_dump, or by matching text / textContains / resourceId / contentDesc on a fresh dump. Errors list candidates when the match is ambiguous.',
    inputSchema: {
      index: z.number().int().optional().describe('Node #index from the last android_ui_dump (must be < ~2 min old).'),
      text: z.string().optional().describe('Exact node text match.'),
      textContains: z.string().optional().describe('Case-insensitive substring match on node text.'),
      resourceId: z.string().optional().describe('Resource id, full (com.app:id/btn) or suffix (btn).'),
      contentDesc: z.string().optional().describe('Case-insensitive substring match on content-desc.'),
      device: z.string().optional().describe('Device serial; defaults to the emulator.'),
    },
    handler: async (args) => {
      const { index, text, textContains, resourceId, contentDesc, device } = args;
      const serial = await resolveSerial(device);
      let node;
      if (index != null) {
        const flat = dumpFromCache(serial);
        node = flat[index];
        if (!node) throw new Error(`no node #${index} in the last dump (${flat.length} nodes) — re-run android_ui_dump`);
      } else {
        if (text == null && textContains == null && resourceId == null && contentDesc == null) {
          throw new Error('provide one of: index, text, textContains, resourceId, contentDesc');
        }
        const flat = await freshDump(serial);
        const matches = findNodes(flat, { text, textContains, resourceId, contentDesc });
        if (!matches.length) {
          return `no match. Visible texts on screen: ${visibleTexts(flat) || '(none)'}. Run android_ui_dump to see the full tree.`;
        }
        if (matches.length > 1) {
          const list = matches.slice(0, 12).map((m) => `#${m.index} text="${clip(m.text, 40)}" desc="${clip(m.desc, 40)}" id=${m.id} ${m.bounds}`).join('\n');
          throw new Error(`${matches.length} matches — pick one by index:\n${list}`);
        }
        node = matches[0];
      }
      const b = centerOf(node);
      await shellOk(serial, `input tap ${b.cx} ${b.cy}`);
      return `tapped (${b.cx},${b.cy}) on #${node.index} ${node.class} text="${clip(node.text, 40)}" id=${node.id}`;
    },
  },
];
