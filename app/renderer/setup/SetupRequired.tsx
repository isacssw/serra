// The one state every screen shows when it needs a bot profile and there isn't one yet (SERRA-51). The shell renders
// it in place of the screen (App.tsx, from the route's `needs`), so no screen has its own copy of the error.
import type { ReactNode } from 'react';
import { ArrowRight, ListChecks } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { Route } from '../routes.ts';
import { Button, EmptyState, Page } from '../ui/index.ts';
import { resumePath, hasProfile } from './setup.logic.ts';
import { useSetup } from './SetupState.tsx';

/** The screen's own title, so the sidebar item still names what opened, and one calm step back to setup. */
const SetupRequired = ({ route }: { route: Route }) => {
  const navigate = useNavigate();
  const { progress } = useSetup();
  const title = route.navLabel ?? route.label;
  return (
    <Page title={title}>
      <div data-setup-required className="pt-6">
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
      </div>
    </Page>
  );
};

/** Shows `children` once the route's need is met, the setup state until then. Before the first read, nothing. */
export const SetupGate = ({ route, children }: { route: Route; children: ReactNode }) => {
  const { progress } = useSetup();
  if (!route.needs) return <>{children}</>;
  if (!progress) return null;
  return hasProfile(progress) ? <>{children}</> : <SetupRequired route={route} />;
};
