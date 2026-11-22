/**
 * Who may hear what a thread's worker was told. A worker reads knowledge pages, each for an audience; what it writes
 * may repeat them, so it may only go where everyone who can see it may hear every page. `deliver` runs this right before
 * each write; the bot runs it before starting a turn, to move a thread whose pages were taken back to a fresh session.
 */
import type { BriefKnowledge } from './knowledge.ts';
import { mayUse, type Visibility } from './owner-model.ts';

/** What a thread's worker was told: who could see the thread when its brief was built, and the pages it could read. */
export interface Heard {
  /** Absent on threads from before audiences. */
  visibility?: Visibility;
  /** Each page, with who could hear the version read. Absent on threads from before Serra recorded them. */
  knowledgeRead?: Record<string, Visibility>;
}

const WIDTH: Record<Visibility, number> = { owner: 0, team: 1, external: 2 };

/** The wider of two audiences. */
export const wider = (a: Visibility | undefined, b: Visibility): Visibility => (a && WIDTH[a] >= WIDTH[b] ? a : b);

/**
 * Pages the worker was told that `current` may not hear: restricted, retired or removed since. Checked for the wider of
 * who could see the thread when it started and `current`. A thread from before Serra recorded its pages was briefed with
 * every page there was, including any removed since, which can't be checked: unless only the owner sees it, it counts as
 * revoked. Returns the audience checked and the knowledge for it too, for a fresh brief.
 */
export const revokedAt = (loadKnowledge: (visibility: Visibility) => BriefKnowledge, heard: Heard, current: Visibility):
  { visibility: Visibility; knowledge: BriefKnowledge; revoked: string[] } => {
  const visibility = wider(heard.visibility, current);
  const knowledge = loadKnowledge(visibility);
  // The owner may hear anything they ever had, removed pages included: nothing of theirs is withheld from them.
  if (visibility === 'owner') return { visibility, knowledge, revoked: [] };
  if (!heard.knowledgeRead) return { visibility, knowledge, revoked: ['(pages from before Serra recorded them)'] };
  // A page is revoked for this audience when the version the worker read wasn't for them, or when the page as it is now
  // isn't (narrowed, retired or removed since).
  return { visibility, knowledge, revoked: Object.entries(heard.knowledgeRead).filter(([page, audience]) => !mayUse(audience, visibility) || !knowledge.pages.includes(page)).map(([page]) => page) };
};

/** Whether `audience` may hear everything the worker was told. Without knowledge configured, nothing is withheld. */
export const mayHearWith = (loadKnowledge: ((visibility: Visibility) => BriefKnowledge) | undefined) =>
  (heard: Heard, audience: Visibility): boolean => !loadKnowledge || revokedAt(loadKnowledge, heard, audience).revoked.length === 0;
