/**
 * The command palette's action registry (⌘K).
 *
 * The palette shows whatever is registered here; it knows no action by name. The shell's own actions are in
 * `builtin.ts`. A screen ticket registers its actions (Promote proposal…, Clean up worktrees) from its own file at
 * module level, so they exist as soon as the screen is imported:
 *
 *   const unregister = registerActions([{ id: 'jobs:cleanup', title: 'Clean up worktrees', group: 'Actions', ... }]);
 *   import.meta.hot?.dispose(unregister);
 *
 * Every action must also be a button somewhere (spike, UX rules): `button` says where, and the palette is only a
 * shortcut to it. Pure data and functions: imported by `node --test` as well as the renderer.
 */
import type { SerraBridge } from '../../main/bridge.ts';
import { fuzzyMatch } from './fuzzy.logic.ts';

/** What an action gets when it runs. */
export interface ActionContext {
  /** `window.serra`, or null outside the app (a plain browser on the Vite dev server). */
  bridge: SerraBridge | null;
  /** Moves the window to a route path, like a sidebar click. */
  navigate(path: string): void;
  /** The shell's toasts (ui/Toast.tsx). */
  toast(toast: { message: string; tone?: 'info' | 'success' | 'error'; action?: { label: string; onClick: () => void } }): void;
}

/** One entry in an argument's pick list. */
export interface Choice {
  value: string;
  label: string;
  detail?: string;
}

/** An action that needs a value first: the palette asks for it as a second step, then calls `run` with it. */
interface ActionArgument {
  /** The field's placeholder, such as "Slack member ID, like U0123456789". */
  placeholder: string;
  /** A line under the field. */
  hint?: string;
  /** A list to pick from (filtered as the owner types). Without it the value is free text. */
  choices?: (context: ActionContext) => Promise<Choice[]>;
}

type ActionGroup = 'Actions' | 'Go to';

/**
 * The order groups are listed in before the owner types anything. Screens come first, so ⌘K then ↩ only ever moves
 * the window; an action that changes something has to be picked on purpose.
 */
const actionGroups: readonly ActionGroup[] = ['Go to', 'Actions'];

export interface Action {
  /** Unique across the registry, such as `bot:restart` or `go:settings-people`. */
  id: string;
  title: string;
  group: ActionGroup;
  /** A short muted label on the right, such as the sidebar section. */
  hint?: string;
  /** Other words that should find it ("daemon" for Restart bot). */
  keywords?: readonly string[];
  /** Where the same action is a button in the app. Required: the palette must never be the only way to do something. */
  button: string;
  argument?: ActionArgument;
  /**
   * Interrupts something running, such as Restart bot. Listed last, and loses a tie on a typed query, so it is never
   * pre-selected by accident.
   */
  destructive?: boolean;
  /** Throws to report a failure; the palette shows the message. */
  run(context: ActionContext, value?: string): void | Promise<void>;
}

export interface ActionRegistry {
  /** Adds actions and returns a function that removes exactly these again. Throws on a duplicate or incomplete action. */
  register(actions: readonly Action[]): () => void;
  /** Everything registered, in registration order. */
  list(): Action[];
}

export const createActionRegistry = (): ActionRegistry => {
  const actions = new Map<string, Action>();
  return {
    register(list) {
      const ids = new Set<string>();
      for (const action of list) {
        for (const field of ['id', 'title', 'button'] as const) {
          if (typeof action[field] !== 'string' || action[field].trim() === '') {
            throw new Error(`Action ${action.id || '(no id)'} needs a ${field}.`);
          }
        }
        if (!actionGroups.includes(action.group)) throw new Error(`Action ${action.id} has an unknown group: ${String(action.group)}.`);
        if (actions.has(action.id) || ids.has(action.id)) throw new Error(`Action ${action.id} is already registered.`);
        ids.add(action.id);
      }
      for (const action of list) actions.set(action.id, action);
      return () => {
        for (const action of list) if (actions.get(action.id) === action) actions.delete(action.id);
      };
    },
    list: () => [...actions.values()],
  };
};

/** The window's registry. Tests make their own with `createActionRegistry`. */
export const actionRegistry = createActionRegistry();
export const registerActions = (actions: readonly Action[]): (() => void) => actionRegistry.register(actions);

export interface ActionResult {
  action: Action;
  /** Matched positions in the title, for highlighting. Empty when the match came from a keyword or the hint. */
  indices: number[];
}

// A keyword or hint match ranks below the same quality of match in the title.
const SECONDARY_PENALTY = 4;

/**
 * What the palette lists for a query. No query: every action, by group, in registration order, destructive ones
 * last. Otherwise the matching actions, best first, ties kept in that same order.
 */
export const searchActions = (actions: readonly Action[], query: string): ActionResult[] => {
  const ordered = [false, true].flatMap((destructive) => actionGroups.flatMap((group) =>
    actions.filter((action) => action.group === group && Boolean(action.destructive) === destructive)));
  if (query.trim() === '') return ordered.map((action) => ({ action, indices: [] }));
  const scored: (ActionResult & { score: number })[] = [];
  for (const action of ordered) {
    const title = fuzzyMatch(query, action.title);
    const others = [...(action.keywords ?? []), ...(action.hint ? [action.hint] : [])]
      .map((word) => fuzzyMatch(query, word))
      .filter((match) => match !== null)
      .map((match) => match.score - SECONDARY_PENALTY);
    const secondary = others.length > 0 ? Math.max(...others) : -Infinity;
    if (!title && secondary === -Infinity) continue;
    if (title && title.score >= secondary) scored.push({ action, indices: title.indices, score: title.score });
    else scored.push({ action, indices: [], score: secondary });
  }
  return scored.sort((a, b) => b.score - a.score).map(({ action, indices }) => ({ action, indices }));
};

/** An argument's choices that match what the owner typed, best first. */
export const searchChoices = (choices: readonly Choice[], query: string): (Choice & { indices: number[] })[] => {
  const scored: (Choice & { indices: number[]; score: number })[] = [];
  for (const choice of choices) {
    const match = fuzzyMatch(query, choice.label);
    if (match) scored.push({ ...choice, indices: match.indices, score: match.score });
  }
  return scored.sort((a, b) => b.score - a.score).map(({ score: _score, ...choice }) => choice);
};
