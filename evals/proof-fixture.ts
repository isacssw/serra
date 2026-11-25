// The proof's invented owner: Robin's fixture eight months on, with rules that changed, newer pages the question
// doesn't point to, stale pages and distractors. Used by evals/kb-proof.ts and evals/kb-review-demo.ts.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // Held out (added in round 7, after the detector was frozen for them): newer rules on pages whose rows don't say so.
  ['triage channels', 'product/escalation.md', 'Where things get triaged'],
  ['launches and announcements', 'product/launches.md', 'What launched lately'],
  ['refund edge cases', 'product/refund-rules.md', 'Refund rules finance asked for'],
  ['monitoring and logs', 'product/observability.md', 'How we watch production'],
  // Held out (round 11, written before any run): changes that aren't a number or a weekday, on pages whose rows
  // don't point to the question. Nothing in the detector or the brief was changed for them.
  ['platform team notes', 'product/platform-notes.md', 'Platform team notes'],
  ['decisions from november planning', 'workflows/november-planning.md', 'Decisions from November planning'],
  ['quarterly updates', 'product/q4-updates.md', 'Q4 updates'],
  ...DISTRACTORS.map(([name, description]): [string, string, string] => [description.toLowerCase(), `product/${name}.md`, description]),
];

/** A scratch profile with Robin's knowledge as it is now (or none), for one run. */
/**
 * `scratchRoot`: where the scratch profile goes. Inside the eval project's folder, a worker in T3's approval-required
 * mode reads the pages without asking, so eval threads stay in a mode Serra can settle.
 */
export const proofProfile = (withKnowledge: boolean, project: string, scratchRoot = tmpdir()): { dir: string; profileDir: string } => {
  mkdirSync(scratchRoot, { recursive: true });
  const dir = mkdtempSync(join(scratchRoot, 'serra-kb-proof-'));
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
    writeFileSync(join(knowledge, 'workflows/rota-changes.md'), `${header('process', 'Changes to how the team works', '2026-11-10')}# Team changes\n\n- The on-call handover moved to Tuesday at 09:00.\n- Standup is async in #ledgerline-standup.\n- Rota swaps now go through Priya while Jonas is on leave.\n`);
    writeFileSync(join(knowledge, 'product/escalation.md'), `${header('product', 'Where things get triaged', '2026-11-15')}# Triage\n\n- Payments bugs now go to #payments-bugs; #ledgerline-triage is for everything else.\n`);
    writeFileSync(join(knowledge, 'product/launches.md'), `${header('product', 'What launched lately', '2026-11-18')}# Launches\n\n- USD is live for merchants since 2026-11-18.\n- The new dashboard home page shipped in October.\n`);
    writeFileSync(join(knowledge, 'product/refund-rules.md'), `${header('product', 'Refund rules finance asked for', '2026-11-01')}# Refund rules\n\n- Partial refunds must be at least 50 minor units.\n- Refunds over 10,000 EUR need a second approver.\n`);
    writeFileSync(join(knowledge, 'product/observability.md'), `${header('product', 'How we watch production', '2026-10-25')}# Observability\n\n- Logs are kept 30 days.\n- Alerts page through PagerDuty.\n`);
    writeFileSync(join(knowledge, 'product/platform-notes.md'), `${header('product', 'Platform team notes', '2026-11-14')}# Platform notes\n\n- Services publish events to Kafka now; NATS was switched off on 2026-10-28.\n- The Go SDK was retired on 2026-11-01; the official SDKs are TypeScript and Python.\n- Dashboards moved from Grafana to Datadog in November; Grafana is read-only.\n- Refunds are created with \`POST /v3/refunds\`; v2 is deprecated since 2026-11-10.\n`);
    writeFileSync(join(knowledge, 'workflows/november-planning.md'), `${header('process', 'Decisions from November planning', '2026-11-16')}# November planning\n\n- Support, not Jonas, posts incidents on the public status page.\n- The public changelog is replaced by a monthly release digest emailed to merchants.\n- Mira's team owns the Grafana-era dashboards' replacements; ask Mira, not Jonas, for new dashboards.\n`);
    writeFileSync(join(knowledge, 'product/q4-updates.md'), `${header('product', 'Q4 updates', '2026-11-19')}# Q4 updates\n\n- The dashboard is live in French since 2026-11-12.\n- Dashboard login moved to SSO through Okta; OAuth login was removed.\n- KYC moved to Onfido: documents are stored there, not by the compliance team.\n`);
    for (const page of ['product/support.md', 'product/refunds-api.md', 'workflows/incident.md']) {
      const file = join(knowledge, page);
      writeFileSync(file, readFileSync(file, 'utf8').replace(/^verified: .*$/m, 'verified: 2026-03-01'));
    }
    for (const [name, description, body] of DISTRACTORS) writeFileSync(join(knowledge, `product/${name}.md`), `${header('product', description, '2026-11-01')}# ${description}\n\n${body}\n`);
    const index = join(knowledge, 'index.md');
    writeFileSync(index, `${readFileSync(index, 'utf8').trimEnd()}\n${ROWS.map(([when, path, gives]) => `| ${when} | \`${path}\` | ${gives} |`).join('\n')}\n`);
  }
  writeFileSync(join(profileDir, 'profile.json'), readFileSync(join(root, 'evals/fixture/profile.json'), 'utf8').replace('PROJECT_PATH', project));
  writeFileSync(join(profileDir, 'brief.md'), readFileSync(join(root, 'templates/brief.md'), 'utf8'));
  writeFileSync(join(profileDir, '.env'), 'SLACK_APP_TOKEN=xapp-eval\nSLACK_BOT_TOKEN=xoxb-eval\n');
  return { dir, profileDir };
};

