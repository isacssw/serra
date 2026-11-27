// Bot & Slack (APP-14): the bot's name and ID, the owner, the review channel and, under Advanced, the service label.
// The bot ID is shown read-only: changing it renames the service and branches, so it goes through a dialog that says so.
import { useId, useState, type FormEvent } from 'react';
import { Pencil } from 'lucide-react';
import type { Profile } from '../../../../src/contracts.ts';
import { Button, cx, Dialog, Input } from '../../ui/index.ts';
import { labelClass, noteClass } from '../../ui/field.ts';
import { botForm, ownerForm, reviewForm, serviceLabelForm } from './settings.logic.ts';
import { Advanced, FieldsCard, SaveError, SettingsPage, SettingsSection, useSectionForm, useSettings, type SettingsState } from './SettingsKit.tsx';

const BotSection = ({ profile, state }: { profile: Profile; state: SettingsState }) => {
  const editor = useSectionForm(botForm, profile, state);
  const formId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [tried, setTried] = useState(false);
  const id = editor.values.id ?? '';
  const problem = botForm.parse({ ...editor.values, id: draft }).errors.id;
  const open = (): void => { setDraft(id); setTried(false); setEditing(true); };
  const apply = (event: FormEvent): void => {
    event.preventDefault();
    setTried(true);
    if (problem) return;
    editor.set('id', draft.trim());
    setEditing(false);
  };
  const idField = editor.field('id');
  return (
    <SettingsSection title="Bot" description="Its name and ID in Slack.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input spellCheck={false} {...editor.field('name')} />
        {/* Read-only on purpose: shown as a value, not a field, with Edit… opening the dialog that warns. */}
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className={labelClass}>{idField.label}</span>
          <div className="flex h-8 items-center gap-2 rounded-lg border border-line bg-raised pr-0.5 pl-2.5">
            <span className={cx('min-w-0 flex-1 truncate font-mono text-[13px]', idField.error ? 'text-down' : 'text-ink')}>{id}</span>
            <Button variant="ghost" size="sm" icon={<Pencil size={13} />} onClick={open} aria-label="Edit bot ID">Edit…</Button>
          </div>
          {idField.error && <p className={noteClass(true)}>{idField.error}</p>}
        </div>
      </div>
      <SaveError message={editor.saveError} />
      <Dialog
        open={editing}
        onClose={() => setEditing(false)}
        title="Change bot ID"
        description="Renames the service and branches. Rebuild the release after."
        actions={(
          <>
            <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form={formId}>Change</Button>
          </>
        )}
      >
        <form id={formId} onSubmit={apply}>
          <Input
            label="Bot ID"
            data-autofocus
            spellCheck={false}
            autoCapitalize="off"
            inputClassName="font-mono placeholder:font-sans"
            placeholder="friday"
            value={draft}
            error={tried || draft !== id ? problem : undefined}
            hint="Lowercase letters, digits, hyphens"
            onChange={(event) => setDraft(event.target.value)}
          />
        </form>
      </Dialog>
    </SettingsSection>
  );
};

export const BotSlack = () => {
  const state = useSettings();
  return (
    <SettingsPage title="Bot & Slack" subtitle={state.profile ? `How ${state.profile.bot.name} shows up, and who it works for.` : undefined} state={state}>
      {(profile) => (
        <>
          <BotSection profile={profile} state={state} />
          <FieldsCard form={ownerForm} profile={profile} state={state} columns={3} />
          <FieldsCard form={reviewForm} profile={profile} state={state} title="Review" />
          <Advanced summary="Service label">
            <FieldsCard form={serviceLabelForm} profile={profile} state={state} columns={1} />
          </Advanced>
        </>
      )}
    </SettingsPage>
  );
};
