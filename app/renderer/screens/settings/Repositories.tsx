// Repositories (APP-14): one table, the main project jobs start in first (marked Main), then the other repositories a
// worker may open threads in. A row is edited in a dialog; the page's save bar saves.
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { Profile } from '../../../../src/contracts.ts';
import { Badge, Button, Dialog, GitHubMark, Input } from '../../ui/index.ts';
import { emptyRepositoryRow, parseRepositories, projectForm, repositoryRows, type FormValues, type RepositoryRow } from './settings.logic.ts';
import { SaveError, SettingsPage, useListEditor, useSectionForm, useSettings, type SettingsState } from './SettingsKit.tsx';

/** What the table shows for one repository, main or other. */
interface Line { key: string; name: string; path: string; base: string; github: string; main: boolean; edited: boolean; invalid: boolean }

const Cell = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <td className={`px-3 py-2.5 align-middle first:pl-4 last:pr-2 ${className}`}>{children}</td>
);

const RepositoryTable = ({ lines, onEdit }: { lines: Line[]; onEdit: (key: string) => void }) => (
  <div className="overflow-hidden rounded-xl border border-line">
    <table className="w-full table-fixed border-collapse text-[13px]">
      <colgroup><col className="w-[22%]" /><col /><col className="w-[18%]" /><col className="w-[20%]" /><col className="w-12" /></colgroup>
      <thead className="border-b border-line text-left text-xs text-faint">
        <tr>
          <th scope="col" className="h-9 pl-4 font-medium">Name</th>
          <th scope="col" className="px-3 font-medium">Path</th>
          <th scope="col" className="px-3 font-medium">Base</th>
          <th scope="col" className="px-3 font-medium">GitHub</th>
          <th scope="col"><span className="sr-only">Edit</span></th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr key={line.key} data-repository={line.key} className="group border-t border-line-subtle first:border-t-0 hover:bg-hover">
            <Cell>
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium text-ink">{line.name}</span>
                {line.main && <Badge tone="accent">Main</Badge>}
                {line.edited && <span aria-label={line.invalid ? 'Needs attention' : 'Edited'} title={line.invalid ? 'Needs attention' : 'Edited'} className={`size-1.5 shrink-0 rounded-full ${line.invalid ? 'bg-down' : 'bg-warn'}`} />}
              </span>
            </Cell>
            <Cell><span className="block truncate font-mono text-xs text-muted" title={line.path}>{line.path || '—'}</span></Cell>
            <Cell><span className="block truncate font-mono text-xs text-muted" title={line.base}>{line.base}</span></Cell>
            <Cell>
              {line.github
                ? <span className="flex min-w-0 items-center gap-1.5 text-muted"><GitHubMark size={13} className="shrink-0 text-faint" /><span className="truncate font-mono text-xs" title={line.github}>{line.github}</span></span>
                : <span className="text-faint">—</span>}
            </Cell>
            <Cell className="text-right">
              <Button variant="ghost" size="sm" aria-label={`Edit ${line.name}`} title="Edit" icon={<Pencil size={13} />} className="w-7 px-0!" onClick={() => onEdit(line.key)} />
            </Cell>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

type Editing = { kind: 'main' } | { kind: 'other'; index: number | null } | null;

/** The main project's fields, in the dialog. `values` is the dialog's own copy until Done. */
const MainFields = ({ values, errors, onChange }: { values: FormValues; errors: Record<string, string>; onChange: (key: string, text: string) => void }) => (
  <div className="grid gap-4 sm:grid-cols-2">
    {projectForm.fields.map((field, index) => (
      <Input
        key={field.key}
        label={field.label}
        placeholder={field.placeholder}
        spellCheck={false}
        inputClassName="font-mono"
        className={field.key === 'path' ? 'sm:col-span-2' : undefined}
        {...(index === 0 ? { 'data-autofocus': true } : {})}
        value={values[field.key] ?? ''}
        error={errors[field.key]}
        onChange={(event) => onChange(field.key, event.target.value)}
      />
    ))}
  </div>
);

const OTHER_FIELDS: { key: keyof RepositoryRow; label: string; placeholder?: string; wide?: boolean; mono?: boolean }[] = [
  { key: 'name', label: 'Name', placeholder: 'docs' },
  { key: 'baseRef', label: 'Base ref', placeholder: 'origin/main', mono: true },
  { key: 'path', label: 'Local path', placeholder: '/Users/you/docs', wide: true, mono: true },
  { key: 'githubRepo', label: 'GitHub repository (optional)', placeholder: 'acme/docs', wide: true, mono: true },
];

const RepositoriesTable = ({ profile, state }: { profile: Profile; state: SettingsState }) => {
  const main = useSectionForm(projectForm, profile, state);
  const others = useListEditor('repositories', profile, repositoryRows, parseRepositories, state);
  const formId = useId();
  const [editing, setEditing] = useState<Editing>(null);
  const [mainDraft, setMainDraft] = useState<FormValues>({});
  const [rowDraft, setRowDraft] = useState<RepositoryRow>(emptyRepositoryRow());
  const [tried, setTried] = useState(false);

  const saved = repositoryRows(profile);
  const lines: Line[] = [
    {
      key: 'main', name: profile.project.githubRepo.split('/').at(-1) || profile.project.path.split('/').filter(Boolean).at(-1) || 'Main project', path: main.values.path ?? '', base: main.values.baseRef ?? '',
      github: main.values.githubRepo ?? '', main: true, edited: main.changed, invalid: Object.keys(main.errors).length > 0,
    },
    ...others.rows.map((row, index): Line => ({
      key: `other-${index}`, name: row.name || 'Untitled', path: row.path, base: row.baseRef, github: row.githubRepo, main: false,
      edited: JSON.stringify(row) !== JSON.stringify(saved[index]),
      invalid: Object.keys(others.errors).some((key) => key.startsWith(`${index}.`)),
    })),
  ];

  const edit = (key: string): void => {
    setTried(false);
    if (key === 'main') { setMainDraft({ ...main.values }); setEditing({ kind: 'main' }); return; }
    const index = Number(key.slice('other-'.length));
    setRowDraft({ ...others.rows[index]! });
    setEditing({ kind: 'other', index });
  };
  const add = (): void => { setTried(false); setRowDraft(emptyRepositoryRow()); setEditing({ kind: 'other', index: null }); };

  // Problems in the dialog: the main project's own checks, or one row checked alone.
  const mainErrors = projectForm.parse(mainDraft).errors;
  const rowErrors = Object.fromEntries(Object.entries(parseRepositories([rowDraft]).errors).map(([key, text]) => [key.slice(2), text]));
  const errors = editing?.kind === 'main' ? mainErrors : rowErrors;
  const shown = tried ? errors : Object.fromEntries(Object.entries(errors).filter(([key]) => (editing?.kind === 'main' ? (mainDraft[key] ?? '') !== (main.values[key] ?? '') : (new Map(Object.entries(rowDraft)).get(key) ?? '') !== '')));

  const done = (event: FormEvent): void => {
    event.preventDefault();
    setTried(true);
    if (!editing || Object.keys(errors).length) return;
    if (editing.kind === 'main') for (const field of projectForm.fields) main.set(field.key, mainDraft[field.key] ?? '');
    else others.put(editing.index, rowDraft);
    setEditing(null);
  };
  const remove = (): void => {
    if (editing?.kind === 'other' && editing.index !== null) others.remove(editing.index);
    setEditing(null);
  };

  const title = editing?.kind === 'main' ? 'Main project' : editing?.index === null ? 'Add repository' : 'Edit repository';
  return (
    <>
      <RepositoryTable lines={lines} onEdit={edit} />
      <div className="-mt-2 flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" flush icon={<Plus size={14} />} onClick={add}>Add repository</Button>
      </div>
      <SaveError message={main.saveError ?? others.saveError} />
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={title}
        description={editing?.kind === 'main' ? 'Where jobs start.' : undefined}
        actions={(
          <>
            {editing?.kind === 'other' && editing.index !== null && (
              <Button variant="ghost" icon={<Trash2 size={14} />} className="mr-auto -ml-3 hover:text-down" onClick={remove}>Remove</Button>
            )}
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" type="submit" form={formId}>{editing?.kind === 'other' && editing.index === null ? 'Add' : 'Done'}</Button>
          </>
        )}
      >
        <form id={formId} onSubmit={done} noValidate>
          {editing?.kind === 'main'
            ? <MainFields values={mainDraft} errors={shown} onChange={(key, text) => setMainDraft((current) => ({ ...current, [key]: text }))} />
            : (
              <div className="grid gap-4 sm:grid-cols-2">
                {OTHER_FIELDS.map((field, index) => (
                  <Input
                    key={field.key}
                    label={field.label}
                    placeholder={field.placeholder}
                    spellCheck={false}
                    className={field.wide ? 'sm:col-span-2' : undefined}
                    inputClassName={field.mono ? 'font-mono' : undefined}
                    {...(index === 0 ? { 'data-autofocus': true } : {})}
                    value={rowDraft[field.key]}
                    error={shown[field.key]}
                    onChange={(event) => setRowDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                  />
                ))}
              </div>
            )}
          {/* Enter in a field submits; the visible Done button sits in the dialog's actions. */}
          <button type="submit" hidden />
        </form>
      </Dialog>
    </>
  );
};

export const Repositories = () => {
  const state = useSettings();
  return (
    <SettingsPage title="Repositories" subtitle="Where jobs start, and other repositories workers may use." state={state}>
      {(profile) => (
        <div className="flex flex-col gap-4">
          <RepositoriesTable profile={profile} state={state} />
        </div>
      )}
    </SettingsPage>
  );
};
