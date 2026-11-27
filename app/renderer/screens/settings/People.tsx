// People (APP-14): who may ask the bot for work. Matches the mockup: name, Slack member ID, the owner locked,
// remove, and add by member ID. Applies now: the daemon reloads allowedUsers live (APP-5). Allowed people's names
// come from Slack through the running bot (`settings.peopleNames`); the app never reads the bot token.
import { useEffect, useState, type FormEvent } from 'react';
import { Lock, Plus, X } from 'lucide-react';
import type { Profile } from '../../../../src/contracts.ts';
import { serra } from '../../bridge.ts';
import { Badge, Button, Input, Table, TBody, Td, Th, THead, Tr } from '../../ui/index.ts';
import { addPersonFieldMessage, addPersonProblem, peopleRows, peopleToName } from './settings.logic.ts';
import { SettingsPage, useSettings } from './SettingsKit.tsx';

/** Slack names of the allowed people, by member ID: known names at once, the rest when the bot finds them. */
const useSlackNames = (profile: Profile | null): Record<string, string> => {
  const [names, setNames] = useState<Record<string, string>>({});
  const ids = profile ? peopleToName(profile).join(',') : '';
  useEffect(() => {
    const bridge = serra();
    if (!bridge || !ids) return;
    let live = true;
    const load = (): void => {
      bridge.settings.peopleNames(ids.split(',')).then((found) => { if (live) setNames(found); }, () => {});
    };
    load();
    const off = bridge.on.names(load);
    return () => { live = false; off(); };
  }, [ids]);
  return names;
};

/** A round initial, so the list reads as people at a glance. */
const Avatar = ({ name }: { name: string | null }) => (
  <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full border border-line bg-raised text-[11px] font-semibold text-muted">
    {(name?.trim()[0] ?? '?').toUpperCase()}
  </span>
);

export const People = () => {
  const state = useSettings();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // Add was pressed with an ID that can't be added: show why, even for an ID still being typed.
  const [tried, setTried] = useState(false);
  const names = useSlackNames(state.profile);

  return (
    <SettingsPage title="People" subtitle={state.profile ? `Who can ask ${state.profile.bot.name} for work.` : undefined} state={state}>
      {(profile) => {
        const rows = peopleRows(profile, names);
        const problem = tried ? addPersonProblem(input, profile) : addPersonFieldMessage(input, profile);
        const canAdd = !!input.trim() && addPersonProblem(input, profile) === null && busy === null;
        const add = async (event: FormEvent): Promise<void> => {
          event.preventDefault();
          if (!canAdd) { setTried(true); return; }
          setTried(false);
          setBusy('add');
          try { await state.addPerson(input.trim()); setInput(''); } catch { /* the toast says why */ } finally { setBusy(null); }
        };
        const remove = async (id: string): Promise<void> => {
          setBusy(id);
          try { await state.removePerson(id); } catch { /* the toast says why */ } finally { setBusy(null); }
        };
        return (
          <div className="flex flex-col gap-4">
            <Table>
              <THead>
                <Tr><Th>Name</Th><Th>Slack member ID</Th><Th className="w-28"><span className="sr-only">Access</span></Th></Tr>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <Tr key={row.slackUserId} className="hover:bg-hover">
                    <Td>
                      <span className="flex min-w-0 items-center gap-2.5">
                        <Avatar name={row.name} />
                        {row.name
                          ? <span className="truncate font-medium text-ink">{row.name}</span>
                          : <span className="truncate text-faint" title="The running bot looks names up in Slack.">Name not known yet</span>}
                      </span>
                    </Td>
                    <Td className="font-mono text-xs text-muted">{row.slackUserId}</Td>
                    <Td className="py-2 text-right">
                      {row.access === 'owner'
                        ? <Badge tone="neutral" title="The owner always has access"><Lock size={11} aria-hidden className="mr-1" />Owner</Badge>
                        : (
                          <Button variant="ghost" size="sm" aria-label={`Remove ${row.name ?? row.slackUserId}`} title="Remove" disabled={busy !== null}
                            className="w-7 px-0! hover:text-down" icon={<X size={14} />} onClick={() => { void remove(row.slackUserId); }} />
                        )}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            <form className="flex items-start gap-2" onSubmit={(event) => { void add(event); }}>
              <Input
                aria-label="Slack member ID"
                placeholder="Slack member ID, like U0…"
                spellCheck={false}
                autoCapitalize="characters"
                className="w-64"
                inputClassName="font-mono"
                value={input}
                error={problem}
                onChange={(event) => { setInput(event.target.value); setTried(false); }}
              />
              <Button type="submit" icon={<Plus size={14} />} disabled={busy !== null}>{busy === 'add' ? 'Adding…' : 'Add person'}</Button>
            </form>
          </div>
        );
      }}
    </SettingsPage>
  );
};
