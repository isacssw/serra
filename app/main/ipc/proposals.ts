// Knowledge proposals (APP-13), on APP-3's services in src/proposals.ts. Handlers only check input and call them.
import { dirname, join } from 'node:path';
import { createProposals } from '../../../src/proposals.ts';
import type { Handlers } from '../bridge.ts';
import type { HandlerContext } from './context.ts';

const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${what} is missing.`);
  return value;
};

export const proposalsHandlers = (context: HandlerContext): Handlers<'proposals'> => {
  // A new service per call: the profile folder can change while the app runs.
  const service = () => createProposals({ knowledgeDir: join(context.profileDir(), 'knowledge') });
  return {
    list: () => service().listProposals(),
    diff: (path) => service().readProposal(text(path, 'Proposal')),
    targets: () => service().listTargets(),
    promote: (path, folder) => {
      const proposals = service();
      const id = text(path, 'Proposal');
      let into = typeof folder === 'string' ? folder.trim() : '';
      if (!into) {
        const { target, folder: named } = proposals.readProposal(id).proposal;
        if (target && dirname(target) !== '.') into = dirname(target);
        else if (named) into = named;
        else throw new Error('Pick a folder to promote the proposal into.');
      }
      return { undoId: proposals.promoteProposal(id, { folder: into }).id };
    },
    mergeInto: (path, target, page) => {
      if (page !== undefined && typeof page !== 'string') throw new Error('The merged page is text.');
      return { undoId: service().mergeProposal(text(path, 'Proposal'), { into: text(target, 'Page to merge into'), ...(page === undefined ? {} : { text: page }) }).id };
    },
    discard: (path) => ({ undoId: service().discardProposal(text(path, 'Proposal')).id }),
    undo: (undoId) => { service().undoProposalChange(text(undoId, 'Undo ID')); },
  };
};
