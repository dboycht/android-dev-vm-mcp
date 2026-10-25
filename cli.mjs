#!/usr/bin/env node
// Human-facing CLI (the AI talks to the same code through MCP instead):
//   node cli.mjs status | setup | boot [--wipe] [--no-snapshot] | shutdown | mcp | selftest
import { createRequire } from 'node:module';
import { log } from './src/util.mjs';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');
const cmd = process.argv[2] || 'help';

function print(obj) {
  console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}

async function main() {
  switch (cmd) {
    case 'status': {
      const { envStatus } = await import('./src/tools/env.mjs');
      print(await envStatus());
      break;
    }
    case 'setup': {
      console.log(`android-dev-vm-mcp ${pkg.version} — SDK bootstrap`);
      console.log('Downloading Android cmdline-tools + platform-tools + emulator + system image (~2.5 GB).');
      console.log('This takes 5-40 minutes depending on your network. Progress below.\n');
      const { ensureSdk } = await import('./src/sdk.mjs');
      let lastPct = -1;
      await ensureSdk({
        onProgress: (p) => {
          if (p.pct != null && p.pct !== lastPct) {
            lastPct = p.pct;
            const mb = Math.round(p.got / 1048576);
            const totalMb = Math.round(p.total / 1048576);
            console.log(`  [${p.stage}] ${p.pct}%  ${mb}/${totalMb} MB`);
          }
        },
      });
      const { ensureAvd } = await import('./src/emulator.mjs');
      const avd = await ensureAvd();
      console.log(`\nSDK ready. AVD "${avd.name}" ${avd.created ? 'created' : 'already existed'}.`);
      console.log('Next: node cli.mjs boot');
      break;
    }
    case 'boot': {
      const wipe = process.argv.includes('--wipe');
      const noSnapshot = process.argv.includes('--no-snapshot');
      console.log('Booting headless emulator (waiting for boot_completed)...');
      const { boot } = await import('./src/emulator.mjs');
      print(await boot({ wipe, noSnapshot }));
      break;
    }
    case 'shutdown': {
      const { shutdown } = await import('./src/emulator.mjs');
      print(await shutdown());
      break;
    }
    case 'mcp': {
      await import('./src/server.mjs');
      break;
    }
    case 'selftest': {
      const { spawn } = await import('node:child_process');
      const args = process.argv.slice(3);
      const child = spawn(process.execPath, ['scripts/selftest.mjs', ...args], { stdio: 'inherit' });
      child.on('close', (code) => process.exit(code ?? 1));
      break;
    }
    default:
      console.log(`android-dev-vm-mcp ${pkg.version}
usage: node cli.mjs <command>
  status                          environment + emulator state
  setup                           download SDK + create AVD (~2.5 GB, one time)
  boot [--wipe] [--no-snapshot]   start headless emulator and wait for boot
  shutdown                        stop the emulator
  selftest [--integration]        run smoke tests (integration needs a booted emulator)
  mcp                             run the MCP stdio server (for MCP client configs)`);
  }
}

main().catch((e) => {
  console.error('ERROR:', e?.message || e);
  log(e?.stack || e);
  process.exit(1);
});
