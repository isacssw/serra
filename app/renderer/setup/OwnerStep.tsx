// Step 3: Slack confirms the owner's member ID with the bot token. The profile already holds the ID, so the check
// runs by itself as the step opens; the field only appears when it fails or the owner wants another ID.
import { useEffect, useRef, useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import { useNavigate } from 'react-router';
import { serra } from '../bridge.ts';
import { Button, Input } from '../ui/index.ts';
import { Card, errorText, StateIcon, StepFooter, StepHeader } from './parts.tsx';
import { FLOW, nextPath, pathForStep, previousPath, stepDone } from './setup.logic.ts';
import { setupChanged, useSetup } from './SetupState.tsx';

const step = FLOW[2]!;

export const OwnerStep = () => {
  const navigate = useNavigate();
  const { progress, refresh } = useSetup();
  const owner = progress?.owner ?? null;
  const slackReady = stepDone(progress, 'slack');
  const confirmed = stepDone(progress, 'owner');
  const [id, setId] = useState(owner?.slackUserId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const tried = useRef(false);

  const confirm = async (memberId: string) => {
    const bridge = serra();
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try {
      await bridge.setup.confirmOwner(memberId.trim());
      setupChanged();
      await refresh();
      setEditing(false);
    } catch (failure) { setError(errorText(failure)); setEditing(true); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (tried.current || confirmed || !slackReady || !owner?.slackUserId) return;
    tried.current = true;
    void confirm(owner.slackUserId);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs once (tried ref) when the owner becomes known; confirm is a fresh closure each render.
  }, [confirmed, slackReady, owner?.slackUserId]);

  const tone = busy ? 'busy' : confirmed ? 'done' : error ? 'problem' : 'todo';
  const line = busy ? `Asking Slack who ${id || owner?.slackUserId} is…`
    : confirmed && owner?.slackName ? `Slack knows you as ${owner.slackName}`
    : error ?? (slackReady ? 'Not confirmed yet' : 'Connect Slack first, so the bot can ask.');

  return (
    <div className="flex flex-col gap-8">
      <StepHeader step={step} icon={<BadgeCheck size={18} strokeWidth={1.75} />} />
      <Card className="flex flex-col gap-3 px-4 py-3.5">
        <div className="flex items-center gap-3">
          <StateIcon tone={tone} />
          <div className="flex min-w-0 flex-1 flex-col">
            <p className={error && !busy ? 'text-[14px] text-down' : 'text-[14px]'} role="status">{line}</p>
            {owner && <p className="font-mono text-[12px] text-muted">{owner.slackUserId}</p>}
          </div>
          {confirmed && !editing && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Use another ID</Button>}
          {!slackReady && <Button size="sm" onClick={() => void navigate(pathForStep('slack'))}>Connect Slack</Button>}
        </div>
        {editing && slackReady && (
          <form className="flex items-start gap-2 pl-8" onSubmit={(event) => { event.preventDefault(); void confirm(id); }}>
            <Input aria-label="Your Slack member ID" inputClassName="font-mono" className="min-w-0 flex-1" value={id} spellCheck={false} autoFocus
              onChange={(event) => { setId(event.target.value); setError(null); }} hint="In Slack: your profile › ⋮ › Copy member ID" />
            <Button type="submit" disabled={busy || !id.trim()}>Check</Button>
          </form>
        )}
      </Card>
      <StepFooter back={previousPath(step.path)}>
        <Button variant="primary" aria-disabled={confirmed ? undefined : true} onClick={() => { if (confirmed) void navigate(nextPath(progress, step.path)); }}>
          Continue
        </Button>
      </StepFooter>
    </div>
  );
};
