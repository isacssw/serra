// People (APP-14): who may ask the bot for work. Matches the mockup: name, Slack member ID, the owner locked,
// remove, and add by member ID. Applies now: the daemon reloads allowedUsers live (APP-5). Allowed people's names
// come from Slack through the running bot (`settings.peopleNames`); the app never reads the bot token.
import { useEffect, useState, type FormEvent } from 'react';
import { Lock, X } from 'lucide-react';
import type { Profile } from '../../../../src/contracts.ts';
import { serra } from '../../bridge.ts';
import { Button, Input, Table, TBody, Td, Th, THead, Tr } from '../../ui/index.ts';
import { addPersonFieldMessage, addPersonProblem, peopleRows, peopleToName } from './settings.logic.ts';
import { SectionCard, SettingsPage, useSettings } from './SettingsKit.tsx';

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

export const People = () => {
  const state = useSettings();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const names = useSlackNames(state.profile);

  return (
    <SettingsPage title="People" sections={['allowedUsers']} state={state}>
      {(profile, settings) => {
        const rows = peopleRows(profile, names);
        const problem = addPersonFieldMessage(input, profile);
        const canAdd = !!input.trim() && addPersonProblem(input, profile) === null && busy === null;
        const add = async (event: FormEvent): Promise<void> => {
          event.preventDefault();
          if (!canAdd) return;
          setBusy('add');
          try { await state.addPerson(input.trim()); setInput(''); } catch { /* the toast says why */ } finally { setBusy(null); }
        };
        const remove = async (id: string): Promise<void> => {
          setBusy(id);
          try { await state.removePerson(id); } catch { /* the toast says why */ } finally { setBusy(null); }
        };
        return (
          <SectionCard section="allowedUsers" settings={settings} description="The owner and these Slack members can ask the bot for work.">
            <Table>
              <THead>
                <Tr><Th>Name</Th><Th>Slack member ID</Th><Th>Access</Th><Th className="w-12"><span className="sr-only">Remove</span></Th></Tr>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <Tr key={row.slackUserId}>
                    <Td className="font-semibold">
                      {row.name ?? <span className="font-normal text-muted" title="The running bot looks names up in Slack.">Name not known yet</span>}
                    </Td>
                    <Td className="font-mono">{row.slackUserId}</Td>
                    <Td>
                      {row.access === 'owner'
                        ? <span className="inline-flex items-center gap-1.5"><Lock size={14} aria-hidden />Owner</span>
                        : 'Allowed'}
                    </Td>
                    <Td className="text-right">
                      {row.access === 'allowed' && (
                        <Button variant="ghost" size="sm" aria-label={`Remove ${row.slackUserId}`} disabled={busy !== null}
                          icon={<X size={16} />} onClick={() => { void remove(row.slackUserId); }} />
                      )}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            <form className="flex items-start gap-3" onSubmit={(event) => { void add(event); }}>
              <Input
                aria-label="Slack member ID"
                placeholder="Slack member ID"
                spellCheck={false}
                autoCapitalize="characters"
                className="w-80"
                value={input}
                error={problem}
                onChange={(event) => setInput(event.target.value)}
              />
              <Button variant="primary" type="submit" disabled={!canAdd}>{busy === 'add' ? 'Adding…' : 'Add person'}</Button>
            </form>
          </SectionCard>
        );
      }}
    </SettingsPage>
  );
};
