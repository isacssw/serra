// "Keep this one" on two rules that disagree, shared by Overview's To do and the graph's card: the kept rule stays,
// the other moves under "Replaced" on its page with the day it stopped holding, saved at once and undoable.
import type { SerraBridge } from '../../main/bridge.ts';
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
