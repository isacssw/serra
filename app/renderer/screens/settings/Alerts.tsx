// Alerts (APP-14): the message triggers. In a listed channel, messages from a chosen bot or person (or anyone)
// start a read-only investigation with the owner's instructions. Each trigger is a row, edited in a dialog; the
// page's save bar appears once something changed. Applies now: the daemon reloads them live (APP-5).
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Bell, Bot, Hash, Pencil, Plus, Trash2, User, Users } from 'lucide-react';
import type { Profile } from '../../../../src/contracts.ts';
import { Badge, Button, Dialog, EmptyState, Input, Select, TextArea } from '../../ui/index.ts';
import {
  emptyTriggerRow, MAX_INSTRUCTIONS, parseTriggers, triggerRows, triggerSummary, type TriggerRow, type TriggerSource,
} from './settings.logic.ts';
import { SaveError, SettingsPage, useListEditor, useSettings, type SettingsState } from './SettingsKit.tsx';

const sources: { value: TriggerSource; label: string; icon: ReactNode }[] = [
  { value: 'bot', label: 'A Slack bot', icon: <Bot size={14} /> },
  { value: 'user', label: 'One person', icon: <User size={14} /> },
  { value: 'any', label: 'Anyone', icon: <Users size={14} /> },
];

const Triggers = ({ profile, state }: { profile: Profile; state: SettingsState }) => {
  const list = useListEditor('messageTriggers', profile, triggerRows, parseTriggers, state);
  const formId = useId();
  const [editing, setEditing] = useState<{ index: number | null } | null>(null);
  const [draft, setDraft] = useState<TriggerRow>(emptyTriggerRow());
  const [tried, setTried] = useState(false);
  const saved = triggerRows(profile);

  const open = (index: number | null): void => {
    setTried(false);
    setDraft(index === null ? emptyTriggerRow() : { ...list.rows[index]! });
    setEditing({ index });
  };
  // The dialog checks its row with the others, so a repeat of another trigger shows here too.
  const others = list.rows.filter((_, index) => index !== editing?.index);
  const checked = parseTriggers([...others, draft]).errors;
  const prefix = `${others.length}.`;
  const errors = Object.fromEntries(Object.entries(checked).filter(([key]) => key.startsWith(prefix)).map(([key, text]) => [key.slice(prefix.length), text]));
  const shown = tried ? errors : Object.fromEntries(Object.entries(errors).filter(([key]) => (new Map<string, string>(Object.entries(draft)).get(key) ?? '') !== ''));

  const done = (event: FormEvent): void => {
    event.preventDefault();
    setTried(true);
    if (!editing || Object.keys(errors).length) return;
    list.put(editing.index, draft);
    setEditing(null);
  };
  const remove = (): void => { if (editing?.index != null) list.remove(editing.index); setEditing(null); };

  return (
    <>
      {list.rows.length === 0
        ? (
          <EmptyState
            icon={<Bell size={18} strokeWidth={1.75} />}
            title="No alerts yet"
            className="border-none bg-transparent py-20"
            action={<Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => open(null)}>Add alert</Button>}
          />
        )
        : (
          <>
            <ul className="flex flex-col divide-y divide-line-subtle overflow-hidden rounded-xl border border-line">
              {list.rows.map((row, index) => {
                const summary = triggerSummary(row);
                const edited = JSON.stringify(row) !== JSON.stringify(saved[index]);
                const invalid = Object.keys(list.errors).some((key) => key.startsWith(`${index}.`));
                return (
                  <li key={index} data-trigger={index} className="flex items-center gap-3 py-3 pr-2 pl-4 hover:bg-hover">
                    <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-canvas text-muted"><Hash size={15} strokeWidth={1.75} /></span>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <p className="flex min-w-0 items-center gap-2 text-[13px]">
                        <span className="truncate font-mono font-medium text-ink">{row.channel || 'No channel'}</span>
                        <span className="shrink-0 text-faint">·</span>
                        <span className="truncate font-mono text-xs text-muted">{summary.source}</span>
                        {edited && <Badge tone={invalid ? 'down' : 'warn'}>{invalid ? 'Fix' : 'Edited'}</Badge>}
                      </p>
                      <p className="truncate text-xs text-faint" title={row.instructions}>{summary.instructions}</p>
                    </div>
                    <Button variant="ghost" size="sm" aria-label={`Edit alert in ${row.channel || 'no channel'}`} title="Edit" icon={<Pencil size={13} />} className="w-7 px-0!" onClick={() => open(index)} />
                  </li>
                );
              })}
            </ul>
            <div className="-mt-2"><Button variant="ghost" size="sm" flush icon={<Plus size={14} />} onClick={() => open(null)}>Add alert</Button></div>
          </>
        )}
      <SaveError message={list.saveError} />
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.index === null ? 'Add alert' : 'Edit alert'}
        description="A match starts a read-only investigation."
        actions={(
          <>
            {editing?.index != null && <Button variant="ghost" icon={<Trash2 size={14} />} className="mr-auto -ml-3 text-down enabled:hover:text-down" onClick={remove}>Remove</Button>}
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" type="submit" form={formId}>{editing?.index === null ? 'Add' : 'Done'}</Button>
          </>
        )}
      >
        <form id={formId} className="grid gap-4 sm:grid-cols-2" onSubmit={done} noValidate>
          <Input label="Channel ID" data-autofocus spellCheck={false} inputClassName="font-mono" placeholder="C0123456789" value={draft.channel} error={shown.channel} onChange={(event) => setDraft({ ...draft, channel: event.target.value })} />
          <Select id="trigger-source" label="Messages from" value={draft.source} options={sources} onChange={(source) => setDraft({ ...draft, source })} />
          {draft.source !== 'any' && (
            <Input
              className="sm:col-span-2"
              label={draft.source === 'bot' ? 'Bot ID' : 'Slack member ID'}
              spellCheck={false}
              inputClassName="font-mono"
              placeholder={draft.source === 'bot' ? 'B0123456789' : 'U0123456789'}
              value={draft.sourceId}
              error={shown.sourceId}
              onChange={(event) => setDraft({ ...draft, sourceId: event.target.value })}
            />
          )}
          <TextArea
            className="sm:col-span-2"
            label="Instructions"
            rows={5}
            placeholder="Find the failing service and the likely cause."
            {...(draft.instructions.length > MAX_INSTRUCTIONS * 0.9 ? { hint: `${draft.instructions.length.toLocaleString()} / ${MAX_INSTRUCTIONS.toLocaleString()}` } : {})}
            value={draft.instructions}
            error={shown.instructions}
            onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
          />
          <button type="submit" hidden />
        </form>
      </Dialog>
    </>
  );
};

export const Alerts = () => {
  const state = useSettings();
  return (
    <SettingsPage title="Alerts" subtitle="Watch a channel and investigate matching messages." state={state}>
      {(profile) => <div className="flex flex-col gap-4"><Triggers profile={profile} state={state} /></div>}
    </SettingsPage>
  );
};
