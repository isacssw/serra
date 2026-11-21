import { join } from 'node:path';
import type { Command } from '../manage.ts';
import { createProposals } from '../proposals.ts';

const USAGE = [
  'pnpm bot proposals --profile /absolute/profile                          list proposals waiting for the owner',
  'pnpm bot proposals show <proposal> --profile /absolute/profile           print the target page and the proposal',
];

const command: Command = {
  summary: 'List and show knowledge proposals. Approve, merge, discard and undo them in the Serra app.',
  usage: USAGE,
  async run({ args, profileDir, log }) {
    const service = createProposals({ knowledgeDir: join(profileDir, 'knowledge') });
    // Positional arguments are the words after `proposals` that aren't flags or flag values.
    const positional = args.slice(1).filter((arg, index, rest) => !arg.startsWith('--') && !rest[index - 1]?.startsWith('--'));
    const [action = 'list', target] = positional;
    const needTarget = (what: string): string => {
      if (!target) throw new Error(`Name the ${what}. Usage:\n${USAGE.join('\n')}`);
      return target;
    };

    switch (action) {
      case 'list': {
        const proposals = service.listProposals();
        if (proposals.length === 0) { log('No proposals waiting.'); return; }
        log(`${proposals.length} proposal${proposals.length === 1 ? '' : 's'} waiting:`);
        for (const proposal of proposals) {
          const into = proposal.target ? ` (changes ${proposal.target})` : '';
          log(`  ${proposal.path}${into}${proposal.description ? ` - ${proposal.description}` : ''}`);
        }
        return;
      }
      case 'show': {
        const diff = service.readProposal(needTarget('proposal'));
        log(diff.current === null ? '(new page)' : `--- current: knowledge/${diff.proposal.target}\n${diff.current}`);
        log(`--- proposed: knowledge/proposals/${diff.proposal.path}\n${diff.proposed}`);
        return;
      }
      case 'promote': case 'merge': case 'discard': case 'undo':
        // A worker runs with the owner's shell, so a command here can't tell the owner from a worker that was talked
        // into it. Approving knowledge is the owner's, in the app.
        throw new Error(`Proposals are approved in the Serra app (Knowledge › Proposals), not from the command line. Here you can list and show them.`);
      default:
        throw new Error(`Unknown proposals action: ${action}. Usage:\n${USAGE.join('\n')}`);
    }
  },
};
export default command;
