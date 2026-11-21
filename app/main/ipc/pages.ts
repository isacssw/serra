// Knowledge pages (APP-20), on the services in src/knowledge.ts. Handlers only check input and call them.
import { join } from 'node:path';
import { readProfileFile } from '../../../src/config.ts';
import { createKnowledge, profileRoots, type KnowledgeRoot } from '../../../src/knowledge.ts';
import type { Handlers } from '../bridge.ts';
import type { HandlerContext } from './context.ts';

const pagePath = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('Page is missing.');
  return value;
};

export const pagesHandlers = (context: HandlerContext): Handlers<'pages'> => {
  // A new service per call: the profile folder can change while the app runs.
  const service = () => createKnowledge(join(context.profileDir(), 'knowledge'));
  /** The checkouts named paths are checked against. A profile.json that doesn't load just skips that check. */
  const roots = (): KnowledgeRoot[] => {
    try {
      return profileRoots(readProfileFile(context.profileDir()));
    } catch {
      return [];
    }
  };
  return {
    list: () => service().listPages({ roots: roots() }),
    read: (path) => service().readPage(pagePath(path)),
    save: (path, text) => {
      if (typeof text !== 'string') throw new Error('A page is text.');
      return service().savePage(pagePath(path), text, { roots: roots() }).page;
    },
    drift: () => service().drift(),
    acceptDrift: () => { service().acceptDrift(); },
    restoreDrift: () => { service().restoreDrift(); },
  };
};
