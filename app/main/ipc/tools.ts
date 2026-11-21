// Tools (APP-23, SERRA-39): read-only. The MCP servers each provider gives the worker (from `claude mcp list` and
// `codex mcp list`, or their config files), and the command-line tools on this Mac. Serra never adds, removes or
// signs in to anything here: servers are managed in Claude or Codex. Only names, transports, hosts, versions and
// statuses reach the window; never a command, an environment, a header or a full URL.
import { readProfileFile } from '../../../src/config.ts';
import { cliOverview, type CliOverview } from '../../../src/clis.ts';
import type { Exec } from '../../../src/exec.ts';
import { liveMcpOverview } from '../../../src/mcp-live.ts';
import type { McpOptions, McpOverview } from '../../../src/mcp.ts';
import type { Handlers } from '../bridge.ts';
import type { HandlerContext } from './context.ts';

/** Tests point these at a temp home, a fake PATH and fake commands. */
export interface ToolsHandlerOptions extends McpOptions {
  run?: Exec;
  path?: string;
}

export const toolsHandlers = (context: HandlerContext, options: ToolsHandlerOptions = {}): Handlers<'tools'> => ({
  overview: (request?: { fresh?: boolean }): Promise<McpOverview> =>
    liveMcpOverview(readProfileFile(context.profileDir()), { ...options, fresh: request?.fresh === true }),
  clis: (request?: { fresh?: boolean }): Promise<CliOverview> => {
    const profileDir = context.profileDir();
    return cliOverview(readProfileFile(profileDir), profileDir, { ...options, fresh: request?.fresh === true });
  },
});
