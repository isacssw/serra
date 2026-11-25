// Six months of an invented owner (Alex) teaching their bot, run through Serra's real approval code with a fake clock:
// the interview, then corrections and new pages the way they arrive in practice, some of them messy, then one tidy
// pass. Used by `tests/knowledge-health.test.ts` (which asserts on it) and `node evals/kb-health.ts` (which prints it).
// No real person's data: Alex, Priya, Jonas and Ledgerline are made up.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createKnowledge } from '../src/knowledge.ts';
import type { KnowledgeChange, KnowledgeFile } from '../src/knowledge-health.ts';
import { createProposals } from '../src/proposals.ts';

const page = (type: string, description: string, body: string, { written = '2026-05-04', verified = 'no', target }: { written?: string; verified?: string; target?: string } = {}): string => [
  '---', `type: ${type}`, `description: ${description}`, 'audience: team', `written: ${written}`, `verified: ${verified}`,
  ...(target ? [`target: ${target}`] : []), 'sources:', `  - Owner, ${written}`, '---', '', body.trim(), '',
].join('\n');

const INDEX = '# Knowledge index\n\nOpen the pages whose row matches the request, and only those.\n\n| When the request | Open | What it gives you |\n|---|---|---|\n';

/** The mess the timeline adds on purpose, which the health check must find, and when each is cleaned up. */
export const PLANTED = {
  conflicts: [
    { pages: ['owner/releases.md', 'owner/working-style.md'], note: 'a correction promoted as a new page: Thursday releases vs Tuesday' },
    { pages: ['owner/working-style.md'], note: 'a hand edit that added a PR size rule beside the old one' },
  ],
  duplicates: [
    { pages: ['people/priya-nair.md', 'people/priya.md'], note: 'a second card for the same person' },
    { pages: ['product/webhook-retries.md', 'product/webhooks.md'], note: 'the retry policy written on two pages' },
  ],
};

export interface Stage { label: string; at: string; files: KnowledgeFile[] }

export interface Simulation {
  files: KnowledgeFile[];
  changes: KnowledgeChange[];
  /** The folder at named moments: after the interview, at its messiest, after the tidy. */
  stages: Stage[];
  now: Date;
}

const readTree = (dir: string, relativeDir = ''): KnowledgeFile[] => readdirSync(join(dir, relativeDir), { withFileTypes: true }).flatMap((entry) => {
  if (entry.name.startsWith('.')) return [];
  const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
  if (entry.isDirectory()) return readTree(dir, path);
  return entry.name.endsWith('.md') ? [{ path, text: readFileSync(join(dir, path), 'utf8') }] : [];
});

/** Runs the timeline in a scratch profile and returns the folder, every backup it left, and three snapshots. */
export const simulateGrowth = (): Simulation => {
  const profile = mkdtempSync(join(tmpdir(), 'serra-kb-growth-'));
  try {
    const knowledge = join(profile, 'knowledge');
    mkdirSync(join(knowledge, 'proposals'), { recursive: true });
    writeFileSync(join(knowledge, 'index.md'), INDEX);
    let clock = new Date('2026-05-04T10:00:00Z');
    const proposals = createProposals({ knowledgeDir: knowledge, now: () => clock });
    const service = createKnowledge(knowledge);
    service.seedApproved();
    const stages: Stage[] = [];
    const at = (date: string): void => { clock = new Date(`${date}T10:00:00Z`); };
    const stage = (label: string): void => { stages.push({ label, at: clock.toISOString(), files: readTree(knowledge) }); };

    /** Each owner action takes a minute, as it would in the app. */
    const tick = (): void => { clock = new Date(clock.getTime() + 60_000); };
    const propose = (name: string, text: string): string => {
      const id = `${clock.toISOString().slice(0, 10)}-${name}`;
      mkdirSync(dirname(join(knowledge, 'proposals', id)), { recursive: true });
      writeFileSync(join(knowledge, 'proposals', id), text);
      return id;
    };
    const reviewed = (id: string) => {
      const { proposed, current, proposal } = proposals.readProposal(id);
      return { proposal: proposed, path: proposal.target, page: current };
    };
    const promote = (folder: string, name: string, text: string, when: string): void => {
      const id = propose(name, text);
      proposals.promoteProposal(id, { reviewed: reviewed(id), folder, when });
      tick();
    };
    const edit = (path: string, change: (text: string) => string): void => {
      const before = service.readPage(path);
      service.savePage(path, change(before), { now: clock, expected: before });
      tick();
    };
    const retire = (path: string): void => {
      proposals.retirePage(path, { reviewed: service.readPage(path) });
      tick();
    };
    const confirm = (path: string): void => edit(path, (text) => text.replace(/^verified: .*$/m, `verified: ${clock.toISOString().slice(0, 10)}`));

    // May: the interview.
    at('2026-05-04');
    promote('owner', 'role.md', page('identity', "Alex's role, hours and priorities", '# Alex\n\n- Staff engineer on the payments API at Ledgerline.\n- Works 09:00 to 17:00 Lisbon time; Fridays are focus days with slow replies.\n- This quarter: multi-currency payouts and duplicate webhook fixes.'), 'who Alex is, hours or priorities');
    promote('owner', 'working-style.md', page('rule', 'How Alex decides about releases, tests and PRs', '# How Alex works\n\n- Risky releases ship on Tuesday, never Friday.\n- A bug fix starts with a failing test.\n- Keep PRs under 400 changed lines; split bigger ones.'), 'releases, tests or PR size');
    promote('owner', 'voice.md', page('voice', 'How Alex writes', '# Voice\n\n- Lead with the answer, then the reason.\n- Short sentences, no exclamation marks.\n- Bullets for anything with more than two steps.'), 'writing in Alex\'s style');
    promote('owner', 'offlimits.md', page('offlimits', 'Topics Alex handles personally', '- Pay, hiring and performance.\n- Dates promised to customers.'), 'pay, hiring, performance or customer dates');
    promote('people', 'priya.md', page('person', 'Who Priya is and how to work with her', '# Priya Nair\n\n- Product manager for payouts. Decides scope.\n- Prefers a short written summary before any call.'), 'mentions Priya');
    stage('After the interview');

    // The next weeks: new knowledge, cleanly.
    at('2026-05-18');
    promote('people', 'jonas.md', page('person', 'Who Jonas is', '# Jonas\n\n- Runs the on-call rota; swaps go through him.\n- Prefers a call for anything urgent.', { written: '2026-05-18' }), 'mentions Jonas');
    at('2026-06-01');
    promote('product', 'webhooks.md', page('product', 'How webhooks are delivered', '# Webhooks\n\n- Webhooks retry 5 times over 24 hours with exponential backoff.\n- Deliveries are signed with the merchant secret.', { written: '2026-06-01' }), 'webhooks, retries or delivery');
    promote('workflows', 'release.md', page('process', 'The release runbook', '# Releasing\n\n1. Tag from main after CI is green.\n2. Deploy to staging and run the smoke suite.\n3. Post the changelog in #releases.', { written: '2026-06-01' }), 'cutting or shipping a release');

    // June to August: the mess that piles up without a tidy pass.
    at('2026-06-15');
    promote('owner', 'releases.md', page('rule', 'When Alex ships releases', '- Risky releases ship on Thursday so the weekend is quiet.', { written: '2026-06-15' }), 'release days');
    at('2026-07-06');
    edit('owner/working-style.md', (text) => `${text.trimEnd()}\n- Keep PRs under 300 changed lines; split bigger ones.\n`);
    at('2026-07-20');
    promote('people', 'priya-nair.md', page('person', 'Who Priya is and how to work with her', '# Priya\n\n- Product manager for payouts. Decides scope.\n- Likes numbers in the first line.', { written: '2026-07-20' }), 'Priya Nair');
    at('2026-08-10');
    promote('product', 'webhook-retries.md', page('product', 'Webhook retry policy', '- Webhooks retry 5 times over 24 hours with exponential backoff.\n- After that the merchant gets an email.', { written: '2026-08-10' }), 'webhook retries');
    at('2026-10-01');
    stage('Before tidying');

    // October: one tidy pass, the way Overview points to it.
    at('2026-10-05');
    edit('owner/working-style.md', (text) => text
      .replace('- Risky releases ship on Tuesday, never Friday.', '- Risky releases ship on Thursday so the weekend is quiet. (since 2026-06-15)')
      .replace('- Keep PRs under 400 changed lines; split bigger ones.\n', '')
      .trimEnd() + '\n\n## Replaced\n\n- Until 2026-06-15: risky releases shipped on Tuesday.\n- Until 2026-07-06: PRs under 400 changed lines.\n');
    retire('owner/releases.md');
    edit('people/priya.md', (text) => text.replace('- Prefers a short written summary before any call.', '- Prefers a short written summary before any call.\n- Likes numbers in the first line.'));
    retire('people/priya-nair.md');
    edit('product/webhooks.md', (text) => text.replace('- Deliveries are signed', '- After the last retry the merchant gets an email.\n- Deliveries are signed'));
    retire('product/webhook-retries.md');
    for (const path of ['owner/role.md', 'owner/voice.md', 'owner/offlimits.md', 'people/priya.md', 'people/jonas.md', 'product/webhooks.md', 'workflows/release.md', 'owner/working-style.md']) confirm(path);
    stage('After tidying');

    const backups = join(profile, 'backups', 'knowledge');
    const changes = existsSync(backups)
      ? readdirSync(backups).flatMap((id) => {
        const file = join(backups, id, 'change.json');
        return existsSync(file) ? [JSON.parse(readFileSync(file, 'utf8')) as KnowledgeChange] : [];
      })
      : [];
    return { files: readTree(knowledge), changes, stages, now: clock };
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
};
