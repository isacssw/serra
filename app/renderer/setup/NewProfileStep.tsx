// Add… › Profile (SB-10): the one step before today's setup. A name, a colour no other profile has, and the agent:
// T3, an agent found on this Mac, or eve on Vercel (SB-17), which asks for its URL and says in one line what leaves
// this Mac. Its button names the host ("Continue with …"): pressing it is the owner's yes, and runs a Check first.
// Continue carries the choices into the "You and your repository" form; nothing is made until that form's Create.
import { useEffect, useState } from 'react';
import { Cloud } from 'lucide-react';
import { useNavigate } from 'react-router';
import { serra } from '../bridge.ts';
import { newProfileLook, takenColors } from '../profiles.logic.ts';
import { defaultPath } from '../routes.ts';
import { useProfiles } from '../shell/profiles.tsx';
import { Avatar, Button, cx, Input } from '../ui/index.ts';
import { emptyEveForm, EveFields, type EveForm } from './EveFields.tsx';
import { EVE_CLOUD_ID, eveContinueLabel, eveHost, holdEveSecret } from './eve.logic.ts';
import { NEW_PROFILE_FORM_PATH, type NewProfileChoice } from './setup.logic.ts';

interface AgentCard { id: string | null; name: string; detail: string }

/** eve on Vercel is always offered: it needs only its URL (and Node, which Serra has). */
const EVE_CARD: AgentCard = { id: EVE_CLOUD_ID, name: 'eve', detail: 'An agent at a URL' };

export const NewProfileStep = () => {
  const navigate = useNavigate();
  const { view } = useProfiles();
  const [name, setName] = useState('');
  const [color, setColor] = useState<string | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentCard[]>([{ id: null, name: 'T3', detail: 'Ready' }, EVE_CARD]);
  const [touched, setTouched] = useState(false);
  const [eve, setEve] = useState<EveForm>(emptyEveForm);
  const [eveError, setEveError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const onEve = agent === EVE_CLOUD_ID;
  const host = eveHost(eve.url);

  // The agents ready on this Mac. Only Serra's own list: a custom agent belongs to the profile that added it.
  useEffect(() => {
    let live = true;
    serra()?.meetings.agentBackend().then((backend) => {
      if (!live) return;
      setAgents([
        { id: null, name: 'T3', detail: 'Ready' },
        ...backend.agents.filter((entry) => entry.installed && !entry.custom && !entry.host).map((entry) => ({ id: entry.id, name: entry.name, detail: 'Ready' })),
        EVE_CARD,
      ]);
    }, () => {});
    return () => { live = false; };
  }, []);

  const look = newProfileLook(view, name);
  const taken = takenColors(view?.profiles ?? [], null);
  const chosen = color ?? look.color;
  const error = touched && !name.trim() ? 'Give it a name.' : undefined;

  const next = async (): Promise<void> => {
    setTouched(true);
    if (!name.trim()) { document.getElementById('new-profile-name')?.focus(); return; }
    let cloud: NewProfileChoice['eve'] = null;
    if (onEve) {
      if (!host) { setEveError('Enter the agent’s URL, like https://researcher.vercel.app.'); return; }
      const bridge = serra();
      if (!bridge) return;
      setEveError(null);
      setChecking(true);
      try {
        // The owner's yes for this host: the Check starts eve and opens a session, with no prompt.
        const check = await bridge.meetings.checkEve({ url: eve.url, team: eve.team, secret: eve.secret, accept: host });
        if (check.result !== 'ok') { setEveError(check.sentence); return; }
      } catch (failure) { setEveError(failure instanceof Error ? failure.message : String(failure)); return; }
      finally { setChecking(false); }
      holdEveSecret(eve.secret);
      cloud = { url: eve.url, team: eve.team, host };
    }
    const choice: NewProfileChoice = { name: name.trim(), color: chosen, agent, ...(cloud ? { eve: cloud } : {}) };
    void navigate(NEW_PROFILE_FORM_PATH, { state: choice });
  };

  return (
    <form className="flex flex-1 flex-col gap-8" noValidate onSubmit={(event) => { event.preventDefault(); void next(); }}>
      <header className="flex flex-col gap-0.5">
        <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.02em]">New profile</h1>
        <p className="text-[13px] text-muted">Its own Slack bot, knowledge and agent.</p>
      </header>

      <div className="flex items-start gap-4">
        <Avatar letters={look.letters} color={chosen} size={44} className="mt-[22px]" />
        <Input id="new-profile-name" label="Name" placeholder="Scout" autoFocus className="min-w-0 flex-1" value={name}
          onChange={(event) => setName(event.target.value)} error={error} hint="How it appears in Slack" />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[13px] text-muted">Colour</legend>
        <div className="flex flex-wrap gap-2">
          {(view?.palette ?? []).map((swatch) => {
            const off = taken.has(swatch);
            const on = swatch === chosen;
            return (
              <button
                key={swatch}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={off ? `${swatch}, taken` : swatch}
                disabled={off}
                onClick={() => setColor(swatch)}
                className={cx('relative size-7 rounded-[7px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus', on && 'ring-2 ring-ink ring-offset-2 ring-offset-canvas')}
                style={{ backgroundColor: swatch }}
              >
                {off && <span aria-hidden className="absolute inset-0 m-auto h-[1.5px] w-[130%] -translate-x-[12%] -rotate-45 bg-avatar-ink/90" />}
              </button>
            );
          })}
        </div>
      </fieldset>

      {agents.length > 1 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-[13px] text-muted">Agent</legend>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
            {agents.map((entry) => {
              const on = entry.id === agent;
              return (
                <label key={entry.id ?? 't3'} className={cx(
                  'flex cursor-pointer flex-col gap-0.5 rounded-xl border px-4 py-3 transition-colors duration-150',
                  'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus',
                  on ? 'border-ink bg-raised' : 'border-line-control bg-panel hover:bg-hover',
                )}>
                  <input type="radio" name="agent" className="sr-only" checked={on} onChange={() => setAgent(entry.id)} />
                  <span className="flex items-center gap-1.5 text-[14px] font-medium">
                    {entry.name}
                    {entry.id === EVE_CLOUD_ID && <Cloud size={13} strokeWidth={1.75} aria-hidden className="text-faint" />}
                  </span>
                  <span className="text-[13px] text-muted">{entry.detail}</span>
                </label>
              );
            })}
          </div>
          {onEve && <div className="mt-3"><EveFields form={eve} onChange={(form) => { setEve(form); setEveError(null); }} error={eveError} /></div>}
        </fieldset>
      )}

      <footer className="mt-auto flex justify-end gap-2 pt-3">
        <Button onClick={() => void navigate(defaultPath)}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={checking}>
          {checking ? 'Checking…' : onEve ? eveContinueLabel(host, 'Continue with') : 'Continue'}
        </Button>
      </footer>
    </form>
  );
};
