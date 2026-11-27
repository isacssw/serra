// Pure helpers for the Brief & policy screen (APP-21), kept free of React so `node --test` covers them.
import type { BriefDocument } from '../../main/bridge.ts';

export const DOCUMENTS: { id: BriefDocument; label: string; file: string; about: string; hint: string }[] = [
  { id: 'brief', label: 'Brief', file: 'brief.md', hint: 'brief.md · {{REQUEST}} filled per job', about: 'The template every worker gets, filled in for its request. Placeholders like {{REQUEST}} are replaced per job.' },
  { id: 'policy', label: 'Policy', file: 'policy.md', hint: 'policy.md · read as written', about: 'Your confirmed workflow choices. Workers read it as written before they change code; it can narrow the brief\'s rules.' },
];

export const SAMPLE_REQUEST = 'Why does the export time out for large projects?';

/** One editor's state: the saved text and the owner's draft. `saved` is null until the first read. */
export interface Draft { saved: string | null; text: string }

export const emptyDraft = (): Draft => ({ saved: null, text: '' });
export const loadedDraft = (saved: string): Draft => ({ saved, text: saved });
export const isDirty = (draft: Draft): boolean => draft.saved !== null && draft.text !== draft.saved;

/** `2026-11-17-lean-brief` → a date and "Lean brief"; a name without a date keeps its words. */
export const proposedLabel = (name: string): { date: string | null; title: string } => {
  const match = /^(\d{4}-\d{2}-\d{2})-?(.*)$/.exec(name);
  const date = match ? match[1]! : null;
  const words = (match ? match[2]! : name).replace(/[-_]+/g, ' ').trim();
  return { date, title: words ? words[0]!.toUpperCase() + words.slice(1) : name };
};

/** Which files a proposal replaces, for the apply dialog. */
export const replacesLine = (documents: BriefDocument[]): string => {
  const files = DOCUMENTS.filter((document) => documents.includes(document.id)).map((document) => document.file);
  return files.length ? `Replaces ${files.join(' and ')}. The current text is backed up in the profile's backups/brief/.` : 'Nothing to apply.';
};
