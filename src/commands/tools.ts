import { cliOverview, formatCliOverview } from '../clis.ts';
import { readProfileFile } from '../config.ts';
import type { Command } from '../manage.ts';
import { liveMcpOverview } from '../mcp-live.ts';
import { formatMcpOverview } from '../mcp.ts';

const command: Command = {
  summary: "List the MCP servers the worker's provider loads in T3, any the alert triggers need, and the command-line tools on this Mac. Read-only.",
  usage: ['pnpm bot tools --profile /absolute/profile [--json]'],
  async run({ flag, profileDir, log }) {
    const profile = readProfileFile(profileDir);
    const [mcp, clis] = await Promise.all([liveMcpOverview(profile), cliOverview(profile, profileDir)]);
    // --json keeps the MCP overview's keys where they were (worker, servers, warnings, files) and adds `clis`.
    log(flag('--json') ? JSON.stringify({ ...mcp, clis }, null, 2) : `${formatMcpOverview(mcp)}\n\n${formatCliOverview(clis)}`);
  },
};
export default command;
