// Knowledge pages (APP-20), on the services in src/knowledge.ts. Handlers only check input and call them.
import { join } from 'node:path';
import { readProfileFile } from '../../../src/config.ts';
import { createKnowledge, profileRoots, type KnowledgeRoot } from '../../../src/knowledge.ts';
import { createMeetingStore } from '../../../src/meeting-store.ts';
import { knowledgeOverview, listKnowledgeFiles } from '../../../src/knowledge-overview.ts';
import { assessKnowledge, confirmHeldBack } from '../../../src/knowledge-health.ts';
import { runKnowledgeReview } from '../../../src/knowledge-review.ts';
import { setReviewWeekly, type KnowledgeReview } from '../../../src/knowledge-review-store.ts';
import { createMeetingRuns } from '../../../src/meeting-runs.ts';
import { chosenBackend } from '../../../src/agent/select.ts';
import { profileT3Bin } from '../../../src/cleanup.ts';
import type { Handlers } from '../bridge.ts';
import type { HandlerContext } from './context.ts';

const pagePath = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('Page is missing.');
  return value;
};

let reviewRun: Promise<KnowledgeReview> | null = null;

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
    list: () => {
      // A meeting approval a crash left half done is rolled back before Pages shows anything (SERRA-62).
      try { createMeetingStore({ knowledgeDir: join(context.profileDir(), 'knowledge') }).recover(); } catch { /* a damaged registry shows in Proposals, never blocks Pages */ }
      const knowledge = service();
      // Opening Pages starts the approved copy for a profile that has none yet (one from before it existed).
      knowledge.seedApproved();
      return knowledge.listPages({ roots: roots() });
    },
    read: (path) => service().readPage(pagePath(path)),
    save: (path, text, expected) => {
      if (typeof text !== 'string') throw new Error('A page is text.');
      if (expected !== undefined && typeof expected !== 'string') throw new Error('Save the page as you loaded it.');
      return service().savePage(pagePath(path), text, { roots: roots(), ...(expected === undefined ? {} : { expected }) }).page;
    },
    drift: () => service().driftDetails(),
    acceptDrift: (path, current) => {
      if (current !== null && typeof current !== 'string') throw new Error('Accept the file as you reviewed it.');
      service().acceptDrift(pagePath(path), current);
    },
    restoreDrift: (path) => { service().restoreDrift(pagePath(path)); },
    aboutMe: (visibility) => {
      if (visibility !== 'owner' && visibility !== 'team' && visibility !== 'external') throw new Error('Pick who sees the reply: owner, team or external.');
      return service().briefKnowledge(visibility).aboutMe;
    },
    untagged: () => service().untaggedDetails(),
    share: (paths, audience) => {
      if (!Array.isArray(paths) || paths.some((item) => typeof item?.path !== 'string' || typeof item?.text !== 'string')) throw new Error('Pick the pages to share.');
      const items = paths as { path: string; text: string }[];
      return service().shareWith(items.map(({ path }) => path), audience, { roots: roots(), seen: Object.fromEntries(items.map(({ path, text }) => [path, text])) });
    },
    canConfirm: (path) => {
      const files = listKnowledgeFiles(join(context.profileDir(), 'knowledge'));
      return !confirmHeldBack(pagePath(path), files, assessKnowledge(files, new Date()));
    },
    issues: (path) => {
      const page = pagePath(path);
      return assessKnowledge(listKnowledgeFiles(join(context.profileDir(), 'knowledge')), new Date()).issues
        .filter((issue) => (issue.kind === 'conflict' || issue.kind === 'duplicate') && issue.pages.includes(page));
    },
    runReview: () => {
      // One review at a time: a second click waits for the first.
      reviewRun ??= (async () => {
        const profileDir = context.profileDir();
        const worker = readProfileFile(profileDir).worker;
        const runs = createMeetingRuns({ t3Bin: profileT3Bin(profileDir), ...(worker?.provider ? { provider: worker.provider } : {}), ...(worker?.model ? { model: worker.model } : {}), backend: () => chosenBackend(profileDir, { t3Bin: profileT3Bin(profileDir) }) });
        return runKnowledgeReview({ profileDir, knowledgeDir: join(profileDir, 'knowledge'), ask: runs.ask });
      })().finally(() => { reviewRun = null; });
      return reviewRun;
    },
    setReviewWeekly: (weekly) => {
      if (typeof weekly !== 'boolean') throw new Error('Turn the weekly review on or off.');
      setReviewWeekly(context.profileDir(), weekly);
    },
    overview: () => knowledgeOverview({ knowledgeDir: join(context.profileDir(), 'knowledge'), profileDir: context.profileDir() }),
  };
};
