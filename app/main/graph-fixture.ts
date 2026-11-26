// A made-up but realistic knowledge folder for Knowledge › Graph (SERRA-93): about sixty pages a few months in, as
// real Markdown with headers, `sources:`, mentions of other pages and people, a usage log and two rules that
// disagree, so the smoke test and the tests drive the real backend. `size` grows it for the 800-page check.
// The people are invented first names, not anyone's workspace.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// path (no .md), heading, written (days before today), uses in the last month, links
type Row = [string, string, number, number, string[]];

const PAGES: Row[] = [
  ['owner/role', 'Your role', 177, 31, ['owner/responsibilities', 'owner/priorities']],
  ['owner/responsibilities', 'What you own', 177, 18, ['product/billing', 'workflows/release-checklist', 'people/priya']],
  ['owner/priorities', 'Priorities', 176, 22, ['product/billing', 'product/api-v3', 'owner/focus-time']],
  ['owner/reviews', 'Code reviews', 176, 26, ['owner/pr-size', 'owner/testing', 'people/felix', 'people/tomas']],
  ['owner/releases', 'Release days', 175, 19, ['workflows/deploy', 'workflows/release-checklist', 'decisions/release-train']],
  ['owner/meetings', 'Meetings', 174, 9, ['owner/focus-time', 'people/priya', 'people/ruth']],
  ['owner/focus-time', 'Focus time', 174, 7, []],
  ['owner/escalation', 'When to escalate', 170, 12, ['workflows/incident', 'people/jonas', 'people/ruth']],
  ['owner/dependencies', 'Adding dependencies', 167, 8, ['people/ines', 'owner/reviews']],
  ['owner/testing', 'Testing', 163, 14, ['people/sara', 'workflows/feature-flags']],
  ['owner/pr-size', 'PR size', 161, 11, []],
  ['owner/voice', 'How you write', 177, 34, ['owner/voice-slack', 'owner/voice-release-notes']],
  ['owner/voice-slack', 'Slack replies', 169, 21, []],
  ['owner/voice-release-notes', 'Release notes', 128, 6, ['workflows/release-checklist']],
  ['owner/off-limits', 'Off-limits', 177, 3, ['owner/customer-data', 'people/ines']],
  ['owner/customer-data', 'Customer data', 155, 5, ['product/analytics', 'workflows/support-handoff']],
  ['people/maya', 'Maya', 173, 10, ['product/onboarding-flow', 'product/mobile-app']],
  ['people/tomas', 'Tomás', 173, 15, ['product/billing', 'product/api-v3', 'decisions/postgres']],
  ['people/priya', 'Priya', 173, 17, ['product/billing', 'product/search', 'product/onboarding-flow']],
  ['people/jonas', 'Jonas', 171, 16, ['workflows/deploy', 'workflows/on-call', 'decisions/monorepo']],
  ['people/lea', 'Lea', 168, 8, ['workflows/support-handoff', 'workflows/triage']],
  ['people/kenji', 'Kenji', 160, 6, ['product/mobile-app']],
  ['people/sara', 'Sara', 160, 9, ['workflows/release-checklist', 'workflows/triage']],
  ['people/omar', 'Omar', 147, 4, ['product/analytics']],
  ['people/ines', 'Inês', 147, 7, ['workflows/incident']],
  ['people/felix', 'Felix', 140, 8, ['product/search', 'product/onboarding-flow']],
  ['people/ruth', 'Ruth', 171, 5, []],
  ['people/ade', 'Ade', 104, 3, ['product/api-v3']],
  ['workflows/deploy', 'Deploys', 170, 24, ['workflows/hotfix', 'workflows/feature-flags', 'workflows/migrations']],
  ['workflows/incident', 'Incidents', 164, 13, ['workflows/on-call', 'workflows/hotfix']],
  ['workflows/on-call', 'On-call', 164, 9, []],
  ['workflows/hotfix', 'Hotfixes', 157, 7, []],
  ['workflows/release-checklist', 'Release checklist', 156, 14, []],
  ['workflows/triage', 'Bug triage', 143, 10, ['workflows/support-handoff']],
  ['workflows/onboarding', 'New joiners', 115, 4, ['people/maya', 'people/jonas', 'decisions/monorepo']],
  ['workflows/migrations', 'DB migrations', 135, 6, ['decisions/postgres', 'people/tomas']],
  ['workflows/feature-flags', 'Feature flags', 121, 8, ['decisions/flags-vendor']],
  ['workflows/support-handoff', 'Support handoff', 100, 5, []],
  ['product/billing', 'Billing v2', 169, 28, ['product/api-v3', 'decisions/postgres']],
  ['product/search', 'Search', 148, 12, ['product/analytics']],
  ['product/mobile-app', 'Mobile app', 133, 9, ['product/onboarding-flow']],
  ['product/api-v3', 'API v3', 113, 15, ['decisions/monorepo']],
  ['product/onboarding-flow', 'Onboarding flow', 98, 7, ['product/analytics']],
  ['product/analytics', 'Analytics', 79, 6, []],
  ['decisions/postgres', 'Stay on Postgres', 142, 5, []],
  ['decisions/monorepo', 'Monorepo', 107, 6, []],
  ['decisions/flags-vendor', 'Flags vendor', 72, 3, []],
  ['decisions/release-train', 'Release train', 58, 8, ['decisions/thursday-releases']],
  ['decisions/thursday-releases', 'Thursday releases', 14, 4, []],
  ['product/pricing', 'Pricing page', 51, 5, ['product/billing', 'people/ade']],
  ['workflows/status-page', 'Status page', 44, 3, ['workflows/incident']],
  ['product/sso', 'SSO', 37, 6, ['people/ines', 'product/api-v3']],
  ['people/noor', 'Noor', 30, 4, ['product/sso', 'product/pricing']],
  ['decisions/node-24', 'Move to Node 24', 23, 3, ['workflows/deploy', 'people/jonas']],
  ['workflows/retro', 'Retros', 16, 2, ['owner/meetings']],
  ['product/webhooks', 'Webhooks', 9, 3, ['product/api-v3', 'people/tomas']],
  ['owner/oncall-swaps', 'On-call swaps', 7, 2, ['workflows/on-call']],
  ['decisions/drop-old-browsers', 'Drop old browsers', 2, 1, ['people/felix']],
];

/** Where pages came from: the interview, meetings and Slack threads, as their `sources:` lines say. */
const SOURCES: [string, string[]][] = [
  ['Owner interview', ['owner/role', 'owner/responsibilities', 'owner/voice', 'owner/off-limits']],
  ['Meeting: deploy walkthrough', ['owner/releases', 'workflows/deploy', 'people/jonas']],
  ['Meeting: incident review', ['workflows/incident', 'workflows/on-call', 'owner/escalation']],
  ['Slack thread: billing v2 kickoff', ['product/billing', 'people/tomas', 'people/priya']],
  ['Meeting: release planning', ['decisions/release-train', 'owner/releases', 'workflows/release-checklist']],
  ['Meeting: SSO kickoff', ['product/sso', 'people/noor', 'people/ines']],
  ['Meeting: mobile sync', ['product/mobile-app', 'people/kenji', 'people/maya']],
];

/** Pages one reply used together. */
const TOGETHER: [string, string][] = [
  ['owner/voice', 'owner/voice-slack'], ['owner/reviews', 'owner/pr-size'], ['owner/releases', 'workflows/release-checklist'],
  ['workflows/deploy', 'workflows/hotfix'], ['owner/priorities', 'product/billing'], ['owner/role', 'owner/voice'],
  ['product/search', 'people/felix'], ['workflows/triage', 'people/lea'], ['owner/testing', 'owner/reviews'],
  ['owner/voice-slack', 'people/lea'], ['product/pricing', 'owner/priorities'], ['workflows/hotfix', 'people/sara'], ['product/webhooks', 'workflows/deploy'],
];

const TYPES: Record<string, string> = { people: 'person', workflows: 'workflow', product: 'project', decisions: 'decisions' };
const typeOf = (path: string): string => {
  const [folder = '', name = ''] = path.split('/');
  if (folder !== 'owner') return TYPES[folder] ?? 'note';
  if (name === 'role') return 'role';
  if (name === 'responsibilities') return 'responsibility';
  if (name.startsWith('voice')) return 'voice';
  if (name === 'off-limits' || name === 'customer-data') return 'offlimits';
  return 'preference';
};

const day = (now: Date, daysAgo: number): string => new Date(now.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);

const TOPICS = ['Exports', 'Imports', 'Teams', 'Invoices', 'Quotas', 'Audit log', 'Themes', 'Payments', 'Sync', 'Uploads', 'Reports', 'Admin', 'CLI', 'SDK',
  'Rollbacks', 'Backups', 'Access', 'Vendors', 'Audits', 'Dashboards', 'Alerts', 'Runbooks', 'Load tests', 'Canaries', 'Branching', 'Naming', 'Logging', 'Errors'];
const FOLDERS = ['product', 'product', 'product', 'workflows', 'workflows', 'owner', 'people', 'people', 'decisions'];

/** 0 → a, 25 → z, 26 → ba: a name part without digits. */
const letters = (n: number): string => (n < 26 ? String.fromCharCode(97 + n) : letters(Math.floor(n / 26)) + String.fromCharCode(97 + (n % 26)));

/** A small deterministic random source, so the grown folder is the same on every run. */
const random = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Writes the folder into `profileDir` (knowledge/ and logs/knowledge-usage.jsonl), dated back from `now`. Returns the
 * page paths written.
 */
export const writeGraphFixture = (profileDir: string, { size = PAGES.length, now = new Date() }: { size?: number; now?: Date } = {}): string[] => {
  const knowledge = join(profileDir, 'knowledge');
  const rows: Row[] = [...PAGES];
  const rand = random(93);
  const sources = new Map<string, string[]>();
  for (const [source, paths] of SOURCES) for (const path of paths) sources.set(path, [...(sources.get(path) ?? []), source]);
  // Grow to `size`: pages on one topic link to each other and to a well-used page of their folder.
  const topicPages = new Map<string, string[]>();
  for (let n = rows.length; n < size; n++) {
    const topic = TOPICS[Math.floor(rand() * TOPICS.length)]!;
    const folder = FOLDERS[Math.floor(rand() * FOLDERS.length)]!;
    const list = topicPages.get(`${folder}:${topic}`) ?? [];
    // Letters, not numbers, tell the grown pages apart: the conflict check reads two lines that differ by a number as
    // two rules that disagree.
    const name = `${folder === 'people' ? `${topic.split(' ')[0]} contact` : topic} ${letters(list.length)}`;
    const path = `${folder}/${name.toLowerCase().replace(/[^a-z]+/g, '-')}-${letters(n)}`;
    const sameFolder = rows.filter(([other]) => other.startsWith(`${folder}/`));
    const links = [...list.slice(-2), ...(sameFolder.length && rand() < 0.6 ? [sameFolder[Math.floor(rand() * sameFolder.length)]![0]] : []), ...(rand() < 0.1 ? [rows[Math.floor(rand() * rows.length)]![0]] : [])];
    rows.push([path, name, Math.floor(Math.pow(rand(), 0.8) * 175), Math.floor(Math.pow(rand(), 3) * 20), [...new Set(links)]]);
    topicPages.set(`${folder}:${topic}`, [...list, path]);
  }
  const heading = new Map(rows.map(([path, title]) => [path, title]));
  for (const [path, title, ago, , links] of rows) {
    const people = links.filter((target) => target.startsWith('people/')).map((target) => `- Check with ${heading.get(target)} first.`);
    const pages = links.filter((target) => !target.startsWith('people/')).map((target) => `\`${target}.md\``);
    // One line for the pages it points to: lines alike but for a name would read as rules that disagree.
    const mentions = [...people, ...(pages.length ? [`- Related: ${pages.join(', ')}.`] : [])];
    // The release day, said two ways: the old page says Tuesday, the decision since says Thursday.
    const rules = path === 'owner/releases' ? ['- Risky releases ship on Tuesday.', '- Announce releases in the team channel.']
      : path === 'decisions/thursday-releases' ? ['- Risky releases ship on Thursday.', '- The release train leaves every week.']
        : [`- Keep ${title.replace(/ [a-z]+$/, '').toLowerCase()} notes short and current.`];
    const text = ['---', `type: ${typeOf(path)}`, `description: ${title}`, 'audience: team', `written: ${day(now, ago)}`, `verified: ${day(now, Math.max(0, ago - 3))}`,
      'sources:', ...(sources.get(path) ?? [`Owner note, ${day(now, ago)}`]).map((source) => `  - ${source}`), '---', '', `# ${title}`, '', ...rules, ...mentions, ''].join('\n');
    mkdirSync(dirname(join(knowledge, `${path}.md`)), { recursive: true });
    writeFileSync(join(knowledge, `${path}.md`), text);
  }
  writeFileSync(join(knowledge, 'index.md'), ['# Knowledge index', '', '| When the request | Open | What it gives you |', '|---|---|---|',
    ...rows.slice(0, 55).map(([path, title]) => `| ${title.toLowerCase()} | \`${path}.md\` | ${title} |`), ''].join('\n'));
  // Replies that used the pages: each page's monthly uses, and the pairs replies used together.
  const uses: string[] = [];
  let run = 0;
  const record = (cited: string[]): void => {
    uses.push(JSON.stringify({ at: new Date(now.getTime() - (1 + (run % 27)) * 86_400_000).toISOString(), runId: `fixture-${run}`, visibility: 'team', cited, offered: 12 }));
    run += 1;
  };
  for (const [path, , , count] of rows) for (let k = 0; k < count; k++) record([`${path}.md`]);
  for (const [a, b] of TOGETHER) record([`${a}.md`, `${b}.md`]);
  mkdirSync(join(profileDir, 'logs'), { recursive: true });
  writeFileSync(join(profileDir, 'logs', 'knowledge-usage.jsonl'), `${uses.join('\n')}\n`);
  return rows.map(([path]) => `${path}.md`);
};
