// UI hierarchy for the AI: uiautomator dump -> parsed flat node list ->
// compact indexed tree text. android_ui_tap resolves text/resource-id matches
// to coordinates, or taps a node by its #index from the last dump.
import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { shell, shellOk, adb, resolveSerial } from './adb.mjs';
import { clip, deviceQuote, ensureDir } from './util.mjs';
import { SHOTS_DIR } from './config.mjs';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

// In-memory cache so #index stays meaningful between dump and tap.
let lastDump = { serial: null, at: 0, flat: [] };
const DUMP_TTL_MS = 120000;

export async function dumpUiFlat(serial) {
  const remote = '/sdcard/aivm_ui.xml';
  let lastErr = '';
  for (let i = 0; i < 3; i++) {
    try {
      await shellOk(serial, `uiautomator dump ${remote}`, { timeoutMs: 20000 });
      const r = await adb(['-s', serial, 'exec-out', 'cat', remote], { timeoutMs: 15000 });
      await shell(serial, `rm ${deviceQuote(remote)}`).catch(() => {});
      const flat = parseDump(r.stdoutBuf ? r.stdoutBuf.toString('utf8') : r.stdout);
      if (flat.length) return flat;
      lastErr = 'parsed 0 nodes';
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error(`uiautomator dump failed after 3 attempts: ${clip(lastErr, 400)}`);
}

function parseDump(xml) {
  if (!xml || !xml.includes('<hierarchy')) return [];
  let doc;
  try {
    doc = parser.parse(xml);
  } catch {
    return [];
  }
  const flat = [];
  (function walk(n, depth) {
    if (Array.isArray(n)) {
      for (const c of n) walk(c, depth);
      return;
    }
    if (!n || typeof n !== 'object') return;
    flat.push({
      depth,
      class: n.class || '',
      text: n.text || '',
      id: n['resource-id'] || '',
      desc: n['content-desc'] || '',
      bounds: n.bounds || '',
      clickable: n.clickable === 'true' || n.clickable === true,
      scrollable: n.scrollable === 'true' || n.scrollable === true,
      enabled: n.enabled !== 'false' && n.enabled !== false,
      index: flat.length,
    });
    if (n.node) walk(n.node, depth + 1);
  })(doc.hierarchy, 0);
  return flat;
}

function parseBounds(b) {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(b || '');
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  return { x1, y1, x2, y2, cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) };
}

export function centerOf(node) {
  const b = parseBounds(node.bounds);
  if (!b) throw new Error(`node #${node.index} has no usable bounds (${node.bounds})`);
  return b;
}

// Keep nodes that are interactive or carry text/desc, plus their ancestors;
// number every kept line with the flat index used by android_ui_tap.
export function formatTree(flat, maxLines = 400) {
  const keep = new Array(flat.length).fill(false);
  const marked = (n) => n.clickable || n.scrollable || n.text || n.desc;
  for (let i = 0; i < flat.length; i++) {
    if (!marked(flat[i])) continue;
    keep[i] = true;
    for (let j = i - 1; j >= 0 && flat[j].depth < flat[i].depth; j--) keep[j] = true;
  }
  const lines = [];
  for (let i = 0; i < flat.length && lines.length < maxLines; i++) {
    if (!keep[i]) continue;
    const n = flat[i];
    const parts = [];
    const cls = (n.class || '').split('.').pop();
    if (cls) parts.push(cls);
    if (n.text) parts.push(`text="${clip(n.text, 60)}"`);
    if (n.desc) parts.push(`desc="${clip(n.desc, 60)}"`);
    if (n.id) parts.push(`id=${n.id}`);
    if (n.clickable) parts.push('CLICKABLE');
    if (n.scrollable) parts.push('scrollable');
    parts.push(n.bounds);
    lines.push(`${'  '.repeat(n.depth)}${parts.join(' ')}  #${i}`);
  }
  return lines.join('\n');
}

export function visibleTexts(flat, max = 30) {
  const texts = flat.filter((n) => n.text || n.desc).slice(0, max)
    .map((n) => `"${clip(n.text || n.desc, 40)}"`);
  return texts.join(', ');
}

export async function freshDump(serial) {
  const flat = await dumpUiFlat(serial);
  lastDump = { serial, at: Date.now(), flat };
  return flat;
}

export function dumpFromCache(serial) {
  if (lastDump.serial !== serial || Date.now() - lastDump.at > DUMP_TTL_MS) {
    throw new Error('no fresh UI dump for this device — call android_ui_dump first, or match by text/resourceId instead of index');
  }
  return lastDump.flat;
}

export function findNodes(flat, { text, textContains, resourceId, contentDesc } = {}) {
  if (resourceId != null) {
    return flat.filter((n) => n.id === resourceId ||
      (!resourceId.includes('/') && n.id.endsWith('/' + resourceId)));
  }
  if (text != null) return flat.filter((n) => n.text === text);
  if (textContains != null) {
    return flat.filter((n) => n.text.toLowerCase().includes(String(textContains).toLowerCase()));
  }
  if (contentDesc != null) {
    return flat.filter((n) => (n.desc || '').toLowerCase().includes(String(contentDesc).toLowerCase()));
  }
  throw new Error('provide one of: index, text, textContains, resourceId, contentDesc');
}

// Save bytes under the project data dir unless the caller passes an absolute path.
export function screenshotPath(savePath) {
  if (savePath && path.isAbsolute(savePath)) return savePath;
  ensureDir(SHOTS_DIR);
  const name = savePath || `shot-${Date.now()}.png`;
  return path.isAbsolute(name) ? name : path.join(SHOTS_DIR, name.replace(/[/\\]/g, '_'));
}
