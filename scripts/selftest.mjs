// Self-test in two modes:
//   node scripts/selftest.mjs                 — MCP protocol smoke test (no SDK needed)
//   node scripts/selftest.mjs --integration   — drive a booted emulator end-to-end
import { spawn } from 'node:child_process';

const integration = process.argv.includes('--integration');
let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// ---- protocol mode: speak JSON-RPC to the server over stdio ---------------
async function protocolTest() {
  const child = spawn(process.execPath, ['src/server.mjs'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {}
    }
  });
  let nextId = 1;
  function rpc(method, params, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  try {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'selftest', version: '0' },
    });
    check('initialize', Boolean(init.result?.serverInfo?.name), init.result?.serverInfo?.name);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const tools = await rpc('tools/list', {});
    const names = (tools.result?.tools || []).map((t) => t.name);
    check('tools/list', names.length >= 25, `${names.length} tools`);
    for (const expected of [
      'android_env_status', 'android_env_setup', 'android_emulator_boot', 'android_emulator_shutdown',
      'android_device_list', 'android_device_info', 'android_shell', 'android_push', 'android_pull', 'android_screenshot',
      'android_tap', 'android_swipe', 'android_text', 'android_key',
      'android_ui_dump', 'android_ui_tap',
      'android_app_list', 'android_app_install', 'android_app_uninstall', 'android_app_launch', 'android_app_stop', 'android_app_clear',
      'android_logcat', 'android_logcat_clear', 'android_settings',
    ]) {
      if (!names.includes(expected)) check(`tool ${expected}`, false, 'missing');
    }

    const st = await rpc('tools/call', { name: 'android_env_status', arguments: {} }, 30000);
    const text = st.result?.content?.[0]?.text || '';
    check('tools/call android_env_status', !st.result?.isError && text.includes('"devices"'), text.slice(0, 120));
  } catch (e) {
    check('protocol conversation', false, e.message);
  } finally {
    child.kill();
  }
}

// ---- integration mode: real emulator required ------------------------------
async function integrationTest() {
  const { listDevices, resolveSerial, screencap, quickInfo, logcatDump, appLaunch, shellOk, shell } =
    await import('../src/adb.mjs');
  const { freshDump, centerOf, formatTree } = await import('../src/ui.mjs');
  const fs = await import('node:fs');

  const devs = await listDevices().catch(() => []);
  const booted = devs.filter((d) => d.state === 'device');
  check('device online', booted.length > 0, devs.map((d) => `${d.serial}(${d.state})`).join(', ') || 'none');
  if (!booted.length) return;

  const serial = await resolveSerial();
  const info = await quickInfo(serial);
  check('device info', Boolean(info.model && info.apiLevel), JSON.stringify(info));

  const buf = await screencap(serial);
  fs.mkdirSync('data/screenshots', { recursive: true });
  fs.writeFileSync('data/screenshots/selftest.png', buf);
  check('screenshot', buf.length > 10000 && buf[1] === 0x50, `${Math.round(buf.length / 1024)} KB`);

  await shellOk(serial, 'input keyevent 3'); // HOME
  await new Promise((r) => setTimeout(r, 1500));
  const flat = await freshDump(serial);
  check('ui dump', flat.length > 5, `${flat.length} nodes`);
  console.log('--- tree preview ---\n' + formatTree(flat, 25) + '\n--------------------');

  await appLaunch(serial, 'com.android.settings');
  await new Promise((r) => setTimeout(r, 2500));
  const flat2 = await freshDump(serial);
  check('launch settings', flat2.some((n) => /settings/i.test(n.text + n.desc + n.id)), '');

  await shellOk(serial, 'input keyevent 4'); // BACK
  await shellOk(serial, 'input tap 540 2200');
  const log = await logcatDump(serial, { lines: 100, priority: 'W' });
  check('logcat', typeof log === 'string', `${log.split('\n').length} lines`);

  const r = await shell(serial, 'echo hello-from-selftest');
  check('shell roundtrip', r.out.includes('hello-from-selftest'), r.out.trim());
}

(async () => {
  if (integration) await integrationTest();
  else await protocolTest();
  console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
