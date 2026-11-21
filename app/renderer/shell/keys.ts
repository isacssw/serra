// Shortcut hints in the platform's words: ⌘N on macOS, Ctrl+N elsewhere (shortcuts.logic.ts follows the same rule).
export const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
/** The modifier as a hint shows it: `${mod}N`. */
export const mod = isMac ? '⌘' : 'Ctrl+';
/** The modifier as `aria-keyshortcuts` names it. */
export const ariaMod = isMac ? 'Meta' : 'Control';
