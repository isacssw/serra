// Settings › Meetings' source rows: how old the last Test's answer is, and what the Test button says.
import type { ProviderStatus } from '../../../../src/meeting-sources.ts';
import { ago } from '../secrets.logic.ts';

/** "Tested 2 h ago", or null for a source with no kept answer. */
export const testedLine = (status: ProviderStatus | undefined, now: Date): string | null =>
  status?.testedAt ? `Tested ${ago(status.testedAt, now)}` : null;

/** "Test", or "Test again" once a source has a kept answer. */
export const testLabel = (status: ProviderStatus | undefined): string => (status?.testedAt ? 'Test again' : 'Test');
