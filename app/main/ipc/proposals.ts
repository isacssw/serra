// Knowledge proposals (APP-13), on APP-3's services in src/proposals.ts. Handlers only check input and call them.
import { dirname, join } from 'node:path';
import { createProposals, type Reviewed } from '../../../src/proposals.ts';
import type { Audience } from '../../../src/owner-model.ts';
import type { Handlers } from '../bridge.ts';
import type { HandlerContext } from './context.ts';

/** What the screen showed the owner: the proposal's text and the page it changes, as strings (null for a new page). */
const reviewedInput = (value: unknown): Reviewed => {
  const shown = value as Partial<Reviewed> | null;
  if (!shown || typeof shown.proposal !== 'string' || (shown.page !== null && typeof shown.page !== 'string') || (shown.path !== null && typeof shown.path !== 'string')) {
    throw new Error('Review the proposal in the app before approving it.');
  }
  return { proposal: shown.proposal, path: shown.path, page: shown.page };
};

/** The audience the owner picked for the approved page, or nothing to keep the proposal's own. */
const audienceInput = (value: unknown): { audience?: Audience } => {
  if (value === undefined || value === null) return {};
  if (value !== 'owner' && value !== 'team' && value !== 'external') throw new Error('Pick who may hear the page: owner, team or external.');
  return { audience: value };
};

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
    promote: (path, folder, reviewed, audience) => {
      const proposals = service();
      const id = text(path, 'Proposal');
      let into = typeof folder === 'string' ? folder.trim() : '';
      if (!into) {
        const { target, folder: named } = proposals.readProposal(id).proposal;
        if (target && dirname(target) !== '.') into = dirname(target);
        else if (named) into = named;
        else throw new Error('Pick a folder to promote the proposal into.');
      }
      return { undoId: proposals.promoteProposal(id, { folder: into, reviewed: reviewedInput(reviewed), ...audienceInput(audience) }).id };
    },
    mergeInto: (path, target, page, reviewed, audience) => {
      if (page !== undefined && typeof page !== 'string') throw new Error('The merged page is text.');
      return { undoId: service().mergeProposal(text(path, 'Proposal'), {
        into: text(target, 'Page to merge into'), reviewed: reviewedInput(reviewed), ...(page === undefined ? {} : { text: page }), ...audienceInput(audience),
      }).id };
    },
    discard: (path) => ({ undoId: service().discardProposal(text(path, 'Proposal')).id }),
    undo: (undoId) => { service().undoProposalChange(text(undoId, 'Undo ID')); },
  };
};
