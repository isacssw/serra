// Keeping one of two rules, shared by Overview's Needs you and the graph's card: the kept rule stays, the other moves
// under "Replaced" on its page with the day it stopped holding, saved at once and undoable. Every save goes through
// the page service, which backs the page up first and refuses a page that changed since it was read.
import type { SerraBridge } from '../../main/bridge.ts';
import { keepNewerForAll, type PairGroup } from './conflicts.logic.ts';
import { currentRules, keepRule, localDate, replacedOn } from './pages.logic.ts';

type Rule = { page: string; text: string };
type Bridge = Pick<SerraBridge, 'pages'>;
/** One page saved: its text before, and its text as saved, read back. */
interface Saved { page: string; before: string; after: string }

/** Saves `next` over `before` (refused if the page moved since) and reads back what was written, for Undo. */
const save = async (bridge: Bridge, page: string, before: string, next: string): Promise<Saved> => {
  await bridge.pages.save(page, next, before);
  return { page, before, after: await bridge.pages.read(page) };
};

/**
 * Puts the pages back, newest first. Each restore names the text this change saved, so a page edited since (another
 * Keep, a hand edit) is refused with the service's message, never overwritten.
 */
const restore = async (bridge: Bridge, saved: readonly Saved[]): Promise<void> => {
  for (const step of [...saved].reverse()) await bridge.pages.save(step.page, step.before, step.after);
};

/**
 * Keeps `kept` and moves `drop` under "Replaced". Returns how to undo it, or 'open' when `drop` isn't a line of its
 * own on the page, so a click can't move it and the page should open instead.
 */
export const keepOne = async (bridge: Bridge, kept: Rule, drop: Rule): Promise<{ undo: () => Promise<void> } | 'open'> => keepOver(bridge, kept, [drop]);

/**
 * Keeps `kept` and moves every one of `drops` under "Replaced": one save per page. All or nothing: if any line isn't
 * a whole line of its page, nothing is saved and the result is 'open'; if a save is refused, the pages saved before it
 * are put back and the refusal is thrown.
 */
export const keepOver = async (bridge: Bridge, kept: Rule, drops: readonly Rule[]): Promise<{ undo: () => Promise<void> } | 'open'> => {
  const date = replacedOn(kept.text, localDate(new Date()));
  const planned: { page: string; before: string; next: string }[] = [];
  for (const page of [...new Set(drops.map((drop) => drop.page))]) {
    const before = await bridge.pages.read(page);
    let next = before;
    for (const drop of drops.filter((one) => one.page === page)) {
      const after = keepRule(next, drop.text, date);
      if (after === next) return 'open';
      next = after;
    }
    // The kept line must still be there: a copy of it is never moved with its own twin.
    if (page === kept.page && !currentRules(next).includes(kept.text.trim())) return 'open';
    planned.push({ page, before, next });
  }
  const saved: Saved[] = [];
  try {
    for (const step of planned) saved.push(await save(bridge, step.page, step.before, step.next));
  } catch (failure) {
    await restore(bridge, saved);
    throw failure;
  }
  return { undo: () => restore(bridge, saved) };
};

/**
 * "Keep newer" on every safe pair of these pages (conflicts.logic.ts says which): one save per page, which the service
 * backs up before it writes, and no other page. Each save names the text it was worked out from, so a page that
 * changed meanwhile is refused, not overwritten. Stops at the first page that fails and says why; the pages saved
 * before it stay saved, and `undo` puts them all back, newest first. `moved` lists the lines that moved, by page.
 */
export const keepNewerOnPages = async (bridge: Bridge, groups: readonly Pick<PairGroup, 'pages' | 'safe'>[], today: string): Promise<{ lines: number; pages: string[]; moved: { page: string; text: string }[]; undo: () => Promise<void>; error?: unknown }> => {
  const saved: Saved[] = [];
  const moved: { page: string; text: string }[] = [];
  let error: unknown;
  for (const group of groups) {
    if (group.pages.length !== 1) continue;
    const page = group.pages[0]!;
    try {
      const before = await bridge.pages.read(page);
      const next = keepNewerForAll(before, page, group.safe, today);
      if (next.moved.length === 0) continue;
      saved.push(await save(bridge, page, before, next.text));
      moved.push(...next.moved.map((text) => ({ page, text })));
    } catch (failure) { error = failure; break; }
  }
  return { lines: moved.length, pages: saved.map(({ page }) => page), moved, undo: () => restore(bridge, saved), ...(error === undefined ? {} : { error }) };
};
