// Bot & Slack (APP-14): the bot's name and ID, the owner, the review channel and, under Advanced, the service label.
// The bot ID is shown read-only: changing it renames the service and branches, so it goes through a dialog that says so.
import { useId, useState, type FormEvent } from 'react';
import { Pencil } from 'lucide-react';
import type { Profile } from '../../../../src/contracts.ts';
import { Button, Dialog, Input } from '../../ui/index.ts';
import { botForm, ownerForm, reviewForm, serviceLabelForm } from './settings.logic.ts';
import { Advanced, FieldsCard, SaveError, SettingsPage, SettingsSection, useSectionForm, useSettings, type SettingsState } from './SettingsKit.tsx';

const BotSection = ({ profile, state }: { profile: Profile; state: SettingsState }) => {
  const editor = useSectionForm(botForm, profile, state);
  const formId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const id = editor.values.id ?? '';
  const problem = botForm.parse({ ...editor.values, id: draft }).errors.id;
  const open = (): void => { setDraft(id); setEditing(true); };
  const apply = (event: FormEvent): void => {
    event.preventDefault();
    if (problem) return;
    editor.set('id', draft.trim());
    setEditing(false);
  };
  const idField = editor.field('id');
  return (
    <SettingsSection title="Bot">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input spellCheck={false} {...editor.field('name')} />
        <div className="flex items-end gap-2">
          <Input readOnly className="flex-1" inputClassName="font-mono" label={idField.label} value={id} error={idField.error} />
          <Button icon={<Pencil size={13} />} onClick={open} aria-label="Edit bot ID">Edit…</Button>
        </div>
      </div>
      <SaveError message={editor.saveError} />
      <Dialog
        open={editing}
        onClose={() => setEditing(false)}
        title="Change bot ID"
        description="It also names the background service and job branches. Prepare a new release after changing it."
        actions={(
          <>
            <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form={formId} disabled={Boolean(problem) || draft.trim() === id}>Change</Button>
          </>
        )}
      >
        <form id={formId} onSubmit={apply}>
          <Input
            label="Bot ID"
            data-autofocus
            spellCheck={false}
            autoCapitalize="off"
            inputClassName="font-mono"
            placeholder="friday"
            value={draft}
            error={draft === id ? undefined : problem}
            hint="Lowercase letters, digits and hyphens."
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
    <SettingsPage title="Bot & Slack" state={state}>
      {(profile) => (
        <>
          <BotSection profile={profile} state={state} />
          <FieldsCard form={ownerForm} profile={profile} state={state} />
          <FieldsCard form={reviewForm} profile={profile} state={state} title="Review" />
          <Advanced summary="Service label">
            <FieldsCard form={serviceLabelForm} profile={profile} state={state} columns={1} />
          </Advanced>
        </>
      )}
    </SettingsPage>
  );
};
