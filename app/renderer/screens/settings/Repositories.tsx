// Repositories (APP-14): the main project jobs start in, and other repositories workers may open threads in.
import { Plus, Trash2 } from 'lucide-react';
import type { Profile } from '../../../../src/contracts.ts';
import { Button, Input } from '../../ui/index.ts';
import { emptyRepositoryRow, parseRepositories, projectForm, repositoryRows } from './settings.logic.ts';
import { FieldsCard, SectionCard, SettingsPage, useListEditor, useSettings, type SectionSettings, type SettingsState } from './SettingsKit.tsx';

const OtherRepositories = ({ profile, settings, state }: { profile: Profile; settings: SectionSettings; state: SettingsState }) => {
  const list = useListEditor('repositories', profile, repositoryRows, parseRepositories, state);
  return (
    <SectionCard
      section="repositories"
      settings={settings}
      description="Other local repositories a worker may open threads in, besides the main project."
    >
      {list.rows.length === 0 && <p className="text-sm text-muted">No other repositories.</p>}
      {list.rows.map((row, index) => (
        <fieldset key={index} className="grid gap-3 rounded-md border border-line p-4 sm:grid-cols-2">
          <legend className="sr-only">Repository {index + 1}</legend>
          <Input label="Name" value={row.name} error={list.errors[`${index}.name`]} onChange={(event) => list.update(index, { name: event.target.value })} />
          <Input label="Local path" spellCheck={false} placeholder="/Users/you/docs" value={row.path} error={list.errors[`${index}.path`]} onChange={(event) => list.update(index, { path: event.target.value })} />
          <Input label="Base ref" spellCheck={false} value={row.baseRef} error={list.errors[`${index}.baseRef`]} onChange={(event) => list.update(index, { baseRef: event.target.value })} />
          <Input label="GitHub repository" hint="Optional." spellCheck={false} placeholder="acme/docs" value={row.githubRepo} error={list.errors[`${index}.githubRepo`]} onChange={(event) => list.update(index, { githubRepo: event.target.value })} />
          <div className="sm:col-span-2">
            <Button variant="ghost" size="sm" flush icon={<Trash2 size={14} />} onClick={() => list.remove(index)}>Remove repository</Button>
          </div>
        </fieldset>
      ))}
      <div><Button size="sm" icon={<Plus size={14} />} onClick={() => list.add(emptyRepositoryRow())}>Add repository</Button></div>
      {list.saveError && <p role="alert" className="text-sm text-down">Not saved: {list.saveError}</p>}
    </SectionCard>
  );
};

export const Repositories = () => {
  const state = useSettings();
  return (
    <SettingsPage title="Repositories" state={state}>
      {(profile, settings) => (
        <>
          <FieldsCard form={projectForm} profile={profile} settings={settings} state={state} />
          <OtherRepositories profile={profile} settings={settings} state={state} />
        </>
      )}
    </SettingsPage>
  );
};
