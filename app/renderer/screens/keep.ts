// "Keep this one" on two rules that disagree, shared by Overview's To do and the graph's card: the kept rule stays,
// the other moves under "Replaced" on its page with the day it stopped holding, saved at once and undoable.
import type { SerraBridge } from '../../main/bridge.ts';
import { keepNewerForAll, type PairGroup } from './conflicts.logic.ts';
import { keepRule, localDate, replacedOn } from './pages.logic.ts';

type Rule = { page: string; text: string };

/**
 * Keeps `kept` and moves `drop` under "Replaced". Returns how to undo it, or 'open' when `drop` isn't a line of its
 * own on the page, so a click can't move it and the page should open instead.
 */
export const keepOne = async (bridge: Pick<SerraBridge, 'pages'>, kept: Rule, drop: Rule): Promise<{ undo: () => Promise<void> } | 'open'> => {
  const before = await bridge.pages.read(drop.page);
  const next = keepRule(before, drop.text, replacedOn(kept.text, localDate(new Date())));
  if (next === before) return 'open';
  await bridge.pages.save(drop.page, next, before);
  return { undo: async () => { await bridge.pages.save(drop.page, before, await bridge.pages.read(drop.page)); } };
};

/**
 * "Keep newer" on every safe pair of these pages (conflicts.logic.ts says which): one save per page, which the service
 * backs up before it writes, and no other page. Each save names the text it was worked out from, so a page that
 * changed meanwhile is refused, not overwritten. Stops at the first page that fails and says why; the pages saved
 * before it stay saved, and `undo` puts them all back, newest first.
 */
export const keepNewerOnPages = async (bridge: Pick<SerraBridge, 'pages'>, groups: readonly Pick<PairGroup, 'pages' | 'safe'>[], today: string): Promise<{ lines: number; pages: string[]; undo: () => Promise<void>; error?: unknown }> => {
  const saved: { page: string; before: string }[] = [];
  let lines = 0;
  let error: unknown;
  for (const group of groups) {
    if (group.pages.length !== 1) continue;
    const page = group.pages[0]!;
    try {
      const before = await bridge.pages.read(page);
      const next = keepNewerForAll(before, page, group.safe, today);
      if (next.moved.length === 0) continue;
      await bridge.pages.save(page, next.text, before);
      saved.push({ page, before });
      lines += next.moved.length;
    } catch (failure) { error = failure; break; }
  }
  const undo = async (): Promise<void> => {
    for (const { page, before } of [...saved].reverse()) await bridge.pages.save(page, before, await bridge.pages.read(page));
  };
  return { lines, pages: saved.map(({ page }) => page), undo, ...(error === undefined ? {} : { error }) };
};
