// Alerts (APP-14): the message triggers. In a listed channel, messages from a chosen bot or person (or anyone)
// start a read-only investigation with the owner's instructions. Applies now: the daemon reloads them live (APP-5).
import { Plus, Trash2 } from 'lucide-react';
import type { Profile } from '../../../../src/contracts.ts';
import { Button, Input } from '../../ui/index.ts';
import { emptyTriggerRow, MAX_INSTRUCTIONS, parseTriggers, triggerRows, type TriggerSource } from './settings.logic.ts';
import { SaveButtons, SectionCard, SettingsPage, TextArea, useListEditor, useSettings, type SectionSettings, type SettingsState } from './SettingsKit.tsx';

const sources: { value: TriggerSource; label: string }[] = [
  { value: 'bot', label: 'A Slack bot (alerts integration)' },
  { value: 'user', label: 'One Slack member' },
  { value: 'any', label: 'Any message in the channel' },
];

const Triggers = ({ profile, settings, state }: { profile: Profile; settings: SectionSettings; state: SettingsState }) => {
  const list = useListEditor('messageTriggers', profile, triggerRows, parseTriggers, state);
  return (
    <SectionCard
      section="messageTriggers"
      settings={settings}
      description="Channels the bot watches. A matching message starts a read-only investigation with these instructions."
      footer={<SaveButtons changed={list.changed} valid={list.valid} saving={list.saving} onSave={() => { void list.save(); }} onReset={list.reset} />}
    >
      {list.rows.length === 0 && <p className="text-sm text-muted">No alert triggers. The bot only answers people who mention it.</p>}
      {list.rows.map((row, index) => (
        <fieldset key={index} className="grid gap-3 rounded-md border border-line p-4 sm:grid-cols-2">
          <legend className="sr-only">Trigger {index + 1}</legend>
          <Input label="Channel ID" spellCheck={false} placeholder="C0123456789" value={row.channel} error={list.errors[`${index}.channel`]} onChange={(event) => list.update(index, { channel: event.target.value })} />
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium" htmlFor={`trigger-source-${index}`}>Messages from</label>
            <select
              id={`trigger-source-${index}`}
              className="h-9 rounded-md border border-line bg-panel px-2 text-sm text-ink focus:outline-2 focus:outline-offset-1 focus:outline-focus"
              value={row.source}
              onChange={(event) => list.update(index, { source: event.target.value as TriggerSource })}
            >
              {sources.map((source) => <option key={source.value} value={source.value}>{source.label}</option>)}
            </select>
          </div>
          {row.source !== 'any' && (
            <Input
              className="sm:col-span-2"
              label={row.source === 'bot' ? 'Bot ID' : 'Slack member ID'}
              spellCheck={false}
              placeholder={row.source === 'bot' ? 'B0123456789' : 'U0123456789'}
              value={row.sourceId}
              error={list.errors[`${index}.sourceId`]}
              onChange={(event) => list.update(index, { sourceId: event.target.value })}
            />
          )}
          <TextArea
            className="sm:col-span-2"
            label="Instructions"
            hint={`${row.instructions.length} / ${MAX_INSTRUCTIONS} characters.`}
            value={row.instructions}
            error={list.errors[`${index}.instructions`]}
            onChange={(event) => list.update(index, { instructions: event.target.value })}
          />
          <div className="sm:col-span-2">
            <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => list.remove(index)}>Remove trigger</Button>
          </div>
        </fieldset>
      ))}
      <div><Button size="sm" icon={<Plus size={14} />} onClick={() => list.add(emptyTriggerRow())}>Add trigger</Button></div>
      {list.saveError && <p role="alert" className="text-sm text-down">Not saved: {list.saveError}</p>}
    </SectionCard>
  );
};

export const Alerts = () => {
  const state = useSettings();
  return (
    <SettingsPage title="Alerts" sections={['messageTriggers']} state={state}>
      {(profile, settings) => <Triggers profile={profile} settings={settings} state={state} />}
    </SettingsPage>
  );
};
