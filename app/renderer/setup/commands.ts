// Setup in ⌘K: open it from anywhere. The same as the sidebar's "Finish setup" row and Serra › Set Up Serra….
import { registerActions } from '../commands/registry.ts';
import { SETUP_PATH } from './setup.logic.ts';

const unregister = registerActions([{
  id: 'setup:open',
  title: 'Set up Serra',
  group: 'Actions',
  keywords: ['setup', 'welcome', 'first run', 'wizard', 'onboard', 'install', 'manifest', 'slack', 'tokens', 'profile', 'finish setup'],
  button: 'Serra › Set Up Serra…',
  run: (context) => context.navigate(SETUP_PATH),
}]);
import.meta.hot?.dispose(unregister);
