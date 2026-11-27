// The Select's keyboard model, as the WAI-ARIA "select-only combobox" pattern: focus stays on the button, arrows move
// the active option, Enter, Space or Tab chooses it, Escape closes without a change, and typing jumps to a label.
// Pure functions: imported by `node --test` as well as the renderer.

export interface SelectChoice {
  label: string;
  disabled?: boolean;
}

/** What a key does: open the list on an option, move within it, choose an option, close it, or nothing. */
export type SelectAction =
  | { type: 'open'; index: number }
  | { type: 'move'; index: number }
  | { type: 'choose'; index: number; keepFocus: boolean }
  | { type: 'close' }
  | { type: 'none' };

/** How far PageUp and PageDown move. */
const PAGE = 10;

/** The first enabled option from `from` in `step` direction, inclusive; `fallback` when there is none. */
export const enabledFrom = (options: readonly SelectChoice[], from: number, step: 1 | -1, fallback = -1): number => {
  for (let i = from; i >= 0 && i < options.length; i += step) if (!options[i]?.disabled) return i;
  return fallback;
};

const first = (options: readonly SelectChoice[]): number => enabledFrom(options, 0, 1);
const last = (options: readonly SelectChoice[]): number => enabledFrom(options, options.length - 1, -1);

/** Where the list opens: on the chosen option if it can be chosen, else the first one that can. */
export const openIndex = (options: readonly SelectChoice[], selected: number): number =>
  selected >= 0 && !options[selected]?.disabled ? selected : first(options);

/**
 * The next option whose label starts with `query` (case-insensitive), searching after `from` and wrapping. Typing
 * one letter again cycles through the options that start with it.
 */
export const typeahead = (options: readonly SelectChoice[], query: string, from: number): number => {
  const q = query.toLocaleLowerCase();
  if (!q) return -1;
  const repeated = q === (q[0] ?? '').repeat(q.length);
  const n = options.length;
  // A fresh search starts at the current option, so "ab" stays on "Abc"; one letter typed again moves on.
  const start = repeated ? from + 1 : Math.max(from, 0);
  for (let k = 0; k < n; k++) {
    const i = (start + k + n) % n;
    const option = options[i];
    if (!option || option.disabled) continue;
    const label = option.label.toLocaleLowerCase();
    if (label.startsWith(q) || (repeated && label.startsWith(q[0] ?? ''))) return i;
  }
  return -1;
};

/** A key with no modifiers that types a character: the typeahead's input. */
export const isPrintable = (key: string, mods: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }): boolean =>
  key.length === 1 && key !== ' ' && !mods.altKey && !mods.ctrlKey && !mods.metaKey;

/** What `key` does to a list that is `open` (or not) with `active` highlighted and `selected` chosen. */
export const selectKey = (
  key: string,
  { open, active, selected, options, altKey = false }: { open: boolean; active: number; selected: number; options: readonly SelectChoice[]; altKey?: boolean },
): SelectAction => {
  if (!open) {
    switch (key) {
      case 'ArrowDown': case 'ArrowUp': case 'Enter': case ' ':
        return { type: 'open', index: openIndex(options, selected) };
      case 'Home': return { type: 'open', index: first(options) };
      case 'End': return { type: 'open', index: last(options) };
      default: return { type: 'none' };
    }
  }
  const at = active >= 0 ? active : openIndex(options, selected);
  switch (key) {
    case 'ArrowDown': return { type: 'move', index: enabledFrom(options, at + 1, 1, at) };
    case 'ArrowUp':
      return altKey ? { type: 'choose', index: at, keepFocus: true } : { type: 'move', index: enabledFrom(options, at - 1, -1, at) };
    case 'Home': return { type: 'move', index: first(options) };
    case 'End': return { type: 'move', index: last(options) };
    case 'PageDown': return { type: 'move', index: enabledFrom(options, Math.min(at + PAGE, options.length - 1), -1, at) };
    case 'PageUp': return { type: 'move', index: enabledFrom(options, Math.max(at - PAGE, 0), 1, at) };
    case 'Enter': case ' ': return { type: 'choose', index: at, keepFocus: true };
    // Tab chooses what is highlighted and lets focus move on.
    case 'Tab': return { type: 'choose', index: at, keepFocus: false };
    case 'Escape': return { type: 'close' };
    default: return { type: 'none' };
  }
};
