// The one state every screen shows when it needs a bot profile and there isn't one yet (SERRA-51). The shell renders
// it in place of the screen (App.tsx, from the route's `needs`), so no screen has its own copy of the error.
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, Bot, ListChecks } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { Route } from '../routes.ts';
import { Button, EmptyState, Page } from '../ui/index.ts';
import type { SetupDetection } from '../../main/bridge.ts';
import { serra } from '../bridge.ts';
import { gateView, hasProfile, resumePath, SETUP_PATH } from './setup.logic.ts';
import { useSetup } from './SetupState.tsx';
import { useProfiles } from '../shell/profiles.tsx';

/**
 * The screen's own title, so the sidebar item still names what opened, and one calm step: pick one of the bots already
 * on this Mac (several profiles and no saved choice, as after lost prefs), or set up the first.
 */
const SetupRequired = ({ route }: { route: Route }) => {
  const navigate = useNavigate();
  const { progress } = useSetup();
  const [detection, setDetection] = useState<SetupDetection | null>(null);
  useEffect(() => { serra()?.setup.detect().then(setDetection, () => {}); }, []);
  const title = route.navLabel ?? route.label;
  const view = gateView(progress, detection);
  return (
    <Page title={title}>
      <div data-setup-required data-gate={view.kind} className="pt-6">
        {view.kind === 'pick' ? (
          <EmptyState
            icon={<Bot size={18} strokeWidth={1.75} />}
            title="Pick your bot"
            action={<Button variant="primary" onClick={() => void navigate(SETUP_PATH)}>Choose<ArrowRight size={14} aria-hidden /></Button>}
          >
            {view.count === 1 ? 'Serra found a bot on this Mac.' : `Serra found ${view.count} bots on this Mac.`}
          </EmptyState>
        ) : (
          <EmptyState
            icon={<ListChecks size={18} strokeWidth={1.75} />}
            title={`Finish setup to use ${title}`}
            action={(
              <Button variant="primary" onClick={() => void navigate(resumePath(progress))}>
                {hasProfile(progress) ? 'Continue setup' : 'Set up Serra'}<ArrowRight size={14} aria-hidden />
              </Button>
            )}
          >
            Serra needs a bot profile first. It takes a few minutes.
          </EmptyState>
        )}
      </div>
    </Page>
  );
};

/** Shows `children` once the route's need is met, the setup state until then. Before the first read, nothing. */
export const SetupGate = ({ route, children }: { route: Route; children: ReactNode }) => {
  const { progress } = useSetup();
  const { servers } = useProfiles();
  if (!route.needs || (route.orServer && servers.length > 0)) return <>{children}</>;
  if (!progress) return null;
  return hasProfile(progress) ? <>{children}</> : <SetupRequired route={route} />;
};
