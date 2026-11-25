// The proof's invented owner: Robin's fixture eight months on, with rules that changed, newer pages the question
// doesn't point to, stale pages and distractors. Used by evals/kb-proof.ts and evals/kb-review-demo.ts.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

const header = (type: string, description: string, verified: string): string =>
  `---\ntype: ${type}\ndescription: ${description}\naudience: team\nwritten: ${verified}\nverified: ${verified}\nsources:\n  - Robin, ${verified}\n---\n\n`;
const DISTRACTORS: [string, string, string][] = [
  ['payouts', 'Merchant payouts', '- Payouts run daily at 04:00 UTC to the merchant\'s settlement account.\n- A failed payout retries the next day.'],
  ['disputes', 'Card disputes', '- Disputes arrive from the acquirer; evidence is due within 7 days.\n- The disputes queue is in the admin console.'],
  ['kyc', 'Merchant onboarding checks', '- New merchants pass KYC before their first payout.\n- KYC documents are kept by the compliance team.'],
  ['ledger', 'The internal ledger', '- Every money movement is a double-entry pair.\n- Ledger entries are immutable; corrections are new entries.'],
  ['reporting', 'Finance reporting', '- Month-end reports go to finance on the second working day.\n- Reports come from the ledger, not the API.'],
  ['search', 'Admin search', '- Admin search indexes merchants and invoices, refreshed every 5 minutes.'],
  ['emails', 'Merchant emails', '- Transactional emails go through the mail service; templates live with product.'],
  ['localisation', 'Localisation', '- The dashboard is in English, Portuguese and German.'],
  ['status-page', 'The status page', '- Incidents are posted on the public status page by Jonas.'],
  ['access', 'Admin access', '- Production admin access needs a ticket and expires after 8 hours.'],
  ['backups', 'Database backups', '- Databases are backed up hourly and kept for 35 days.'],
  ['load-tests', 'Load tests', '- Load tests run in the perf environment on Wednesday nights.'],
  ['partners', 'Partner integrations', '- Partner integrations use their own API keys and lower rate limits.'],
  ['pricing', 'Merchant pricing', '- Pricing is set by sales; engineering never quotes prices.'],
  ['roadmap', 'Public roadmap', '- The public roadmap is updated by product each quarter.'],
];
const ROWS: [string, string, string][] = [
  ['pricing plans or packaging', 'product/plans.md', 'Plans and packaging for sales'],
  ['rota changes', 'workflows/rota-changes.md', 'Changes to how the team works'],
  ['announcing changes to merchants', 'product/release-policy.md', 'How changes reach merchants'],
  ['settlement or money movement', 'product/treasury.md', 'Treasury and money movement'],
  ['merchant privacy promises', 'product/privacy.md', 'Privacy commitments to merchants'],
  ...DISTRACTORS.map(([name, description]): [string, string, string] => [description.toLowerCase(), `product/${name}.md`, description]),
];

/** A scratch profile with Robin's knowledge as it is now (or none), for one run. */
export const proofProfile = (withKnowledge: boolean, project: string): { dir: string; profileDir: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'serra-kb-proof-'));
  const profileDir = join(dir, 'profile');
  const knowledge = join(profileDir, 'knowledge');
  cpSync(join(root, 'evals/fixture/knowledge'), knowledge, { recursive: true });
  if (!withKnowledge) {
    // No notes: the shipped empty index and nothing else.
    rmSync(knowledge, { recursive: true, force: true });
    cpSync(join(root, 'templates/knowledge'), knowledge, { recursive: true });
  } else {
    const style = join(knowledge, 'owner/working-style.md');
    writeFileSync(style, readFileSync(style, 'utf8').replace('- A bug fix starts with a failing test.', '- A bug fix starts with a failing test.\n- Risky releases ship on Thursday now (since 2026-10-01), never Friday.'));
    const oncall = join(knowledge, 'product/oncall.md');
    writeFileSync(oncall, readFileSync(oncall, 'utf8').replace(/^verified: .*$/m, 'verified: 2026-05-01'));
    writeFileSync(style, readFileSync(style, 'utf8').replace('- Keep PRs under 400 changed lines; split bigger ones.', '- Keep PRs under 400 changed lines; split bigger ones.\n- Keep PRs under 300 changed lines now (since 2026-09-15).'));
    for (const [page, date] of [['product/feature-flags.md', '2026-05-01'], ['product/data-retention.md', '2026-04-01'], ['product/currencies.md', '2026-05-01']] as const) {
      const file = join(knowledge, page);
      writeFileSync(file, readFileSync(file, 'utf8').replace(/^verified: .*$/m, `verified: ${date}`));
    }
    writeFileSync(join(knowledge, 'product/release-policy.md'), `${header('product', 'How changes reach merchants', '2026-11-05')}# Rollouts\n\n- Feature flags roll out 10%, 50%, 100% over two days.\n- Every rollout is announced in #ledgerline-releases.\n`);
    writeFileSync(join(knowledge, 'product/treasury.md'), `${header('product', 'Treasury and money movement', '2026-10-30')}# Treasury\n\n- FX rates come from the treasury feed at 05:00 UTC.\n- Settlement batches close at 16:00 UTC.\n`);
    writeFileSync(join(knowledge, 'product/privacy.md'), `${header('product', 'Privacy commitments to merchants', '2026-11-12')}# Privacy\n\n- Webhook payloads are kept 14 days.\n- Merchants can ask for an export of their data at any time.\n`);
    const limits = join(knowledge, 'product/rate-limits.md');
    writeFileSync(limits, readFileSync(limits, 'utf8').replace(/^verified: .*$/m, 'verified: 2026-06-01'));
    writeFileSync(join(knowledge, 'product/plans.md'), `${header('product', 'Plans and packaging for sales', '2026-10-20')}# Plans\n\n- Standard and Plus plans; Plus adds priority support.\n- The API rate limit is 250 requests per second per merchant on every plan.\n`);
    writeFileSync(join(knowledge, 'workflows/rota-changes.md'), `${header('process', 'Changes to how the team works', '2026-11-10')}# Team changes\n\n- The on-call handover moved to Tuesday at 09:00.\n- Standup is async in #ledgerline-standup.\n`);
    for (const [name, description, body] of DISTRACTORS) writeFileSync(join(knowledge, `product/${name}.md`), `${header('product', description, '2026-11-01')}# ${description}\n\n${body}\n`);
    const index = join(knowledge, 'index.md');
    writeFileSync(index, `${readFileSync(index, 'utf8').trimEnd()}\n${ROWS.map(([when, path, gives]) => `| ${when} | \`${path}\` | ${gives} |`).join('\n')}\n`);
  }
  writeFileSync(join(profileDir, 'profile.json'), readFileSync(join(root, 'evals/fixture/profile.json'), 'utf8').replace('PROJECT_PATH', project));
  writeFileSync(join(profileDir, 'brief.md'), readFileSync(join(root, 'templates/brief.md'), 'utf8'));
  writeFileSync(join(profileDir, '.env'), 'SLACK_APP_TOKEN=xapp-eval\nSLACK_BOT_TOKEN=xoxb-eval\n');
  return { dir, profileDir };
};

