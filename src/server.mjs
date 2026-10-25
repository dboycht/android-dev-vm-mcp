// MCP stdio server: registers all android_* tools. stdout is reserved for the
// MCP protocol; diagnostics go to stderr (util.log) and data/aivm.log.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pkgVersion } from './config.mjs';
import { log } from './util.mjs';
import { envTools } from './tools/env.mjs';
import { deviceTools } from './tools/device.mjs';
import { inputTools } from './tools/input.mjs';
import { uiTools } from './tools/ui.mjs';
import { appTools } from './tools/app.mjs';
import { debugTools } from './tools/debug.mjs';

const allTools = [...envTools, ...deviceTools, ...inputTools, ...uiTools, ...appTools, ...debugTools];

const mcp = new McpServer({ name: 'android-dev-vm-mcp', version: pkgVersion() });

for (const t of allTools) {
  mcp.registerTool(
    t.name,
    { description: t.description, inputSchema: t.inputSchema },
    async (args) => {
      try {
        const res = await t.handler(args ?? {});
        if (Array.isArray(res)) return { content: res };
        return {
          content: [{ type: 'text', text: typeof res === 'string' ? res : JSON.stringify(res, null, 2) }],
        };
      } catch (e) {
        log('tool error:', t.name, e?.stack || e);
        return { content: [{ type: 'text', text: `ERROR: ${e?.message || e}` }], isError: true };
      }
    },
  );
}

await mcp.connect(new StdioServerTransport());
log(`android-dev-vm-mcp ${pkgVersion()} ready over stdio: ${allTools.length} tools`);
