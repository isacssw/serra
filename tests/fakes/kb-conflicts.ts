// A made-up knowledge base shaped like the one in SERRA-115: rules the bot learned again on a later day with the day
// written into each line, a few real disagreements, meeting decisions with their `(date, meeting)` notes, and pages to
// tidy. No real person's data: the owner is "Sam", the products and people are invented.
import type { KnowledgeFile } from '../../src/knowledge-health.ts';

const header = (type: string, description: string, extra = ''): string =>
  `---\ntype: ${type}\ndescription: ${description}\nwritten: 2026-11-18\nverified: 2026-11-18\naudience: owner\nsources:\n  - Sam in DM, 2026-11-16\n${extra}---\n`;

/** The pages, in the old format: each restated rule is a new dated line beside the old one. */
export const OLD_FORMAT_PAGES: KnowledgeFile[] = [
  {
    path: 'owner/pr-rules.md',
    text: `${header('rule', "Sam's rules on attribution, proof, branch names, PRs")}# PRs\n\n`
      + '- Open every PR as a draft and link the Linear issue (2026-11-16)\n'
      + '- Open every PR as a draft and link the Linear issue (2026-11-17)\n'
      + '- Open every PR as a draft and link the Linear issue, and attach proof (2026-11-18)\n'
      + '- Branch names use type/short-name, lowercase only (2026-11-16)\n'
      + '- Branch names use type/short-name (2026-11-17)\n'
      + '- End each commit message with the co-author line for the agent (2026-11-16)\n'
      + '- End each commit message with the co-author line for the agent (2026-11-17)\n'
      + '- Say in the PR description which agent and model did the work (2026-11-17)\n'
      + '- Say in the PR description which agent and model did the work (2026-11-18)\n',
  },
  {
    path: 'owner/quick-vs-right.md',
    text: `${header('rule', 'How Sam weighs quick against right, scope growth, design conflicts and claims')}# Trade-offs\n\n`
      + '- Prefer the small fix that ships today over the big rewrite (2026-11-16)\n'
      + '- Prefer the small fix that ships today over the big rewrite (2026-11-17)\n'
      + '- When scope grows past the ticket, stop and ask Sam first (2026-11-16)\n'
      + '- When scope grows past the ticket, stop and ask Sam first (2026-11-17)\n'
      + '- Back every claim in a reply with a link or a test result (2026-11-16)\n'
      + '- Back every claim in a reply with a link or a test result (2026-11-17)\n',
  },
  {
    path: 'product/squad-products.md',
    text: `${header('product', "The four products Sam's squad owns, where each stands, and what the bot can touch")}# Products\n\n`
      + '- Ledgerline sends payouts over 4 rails: ACH, SEPA, Pix and cards (2026-11-16)\n'
      + '- Ledgerline sends payouts over 4 rails: ACH, SEPA, Pix and cards (2026-11-17)\n'
      + '- Tallybook is in maintenance: bug fixes only, no new features (2026-11-16)\n'
      + '- Tallybook is in maintenance: bug fixes only, no new features (2026-11-17)\n'
      + '- See the [squad wiki](https://wiki.acme.dev/squad) before changing a product owner (2026-11-16)\n'
      + '- See the [squad wiki](https://wiki.acme.dev/squad-v2) before changing a product owner (2026-11-17)\n',
  },
  {
    path: 'workflows/code-change.md',
    text: `${header('workflow', 'How a code change ships: proof, the two workflow skills, the self-review')}# Shipping\n\n`
      + '- Never merge a PR before Sam reviews it (2026-11-16)\n'
      + '- Merge a PR before Sam reviews it when CI is green and the fix is small (2026-11-18)\n'
      + '- Run the self-review skill before asking for a review (2026-11-16)\n',
  },
  {
    path: 'projects/live-breach.md',
    text: `${header('project', 'Live Breach, the B2B incident-response exercise on real systems')}# Live Breach\n\n`
      + '- Each Live Breach exercise runs 3 hours with the client team (2026-11-16)\n'
      + '- Each Live Breach exercise runs 4 hours with the client team (2026-11-17)\n'
      + '- The scenario owner is Priya on the security team (2026-11-16)\n',
  },
  {
    path: 'decisions/payments.md',
    text: `${header('decisions', 'What the payments syncs decided')}# Payments decisions\n\n## Decisions\n\n`
      + '- Refunds v2 ships on Tuesday behind a flag (2026-11-10, Payments sync: Ana) <!-- m:a1b2c3 -->\n'
      + '- Refunds v2 ships on Tuesday behind a flag (2026-11-17, Payments sync: Ana, Bruno) <!-- m:d4e5f6 -->\n'
      + '- Card disputes go to the risk queue within 2 days (2026-11-17, Payments sync: Ana) <!-- m:d4e5f6 -->\n',
  },
  {
    path: 'workflows/on-call.md',
    text: `${header('workflow', 'How on-call works for the payments squad')}# On-call\n\n`
      + 'On-call rotates every Monday at noon and the person coming off hands over in the channel with open incidents listed. '
      + 'Pages that fire at night go to the primary first and to the secondary after fifteen minutes without an answer. '
      + 'Nobody changes a payout rail during their on-call week unless the incident needs it and Sam agrees in writing. '
      + 'The handover note lists every open incident, every flag still on, and anything the next person should watch.\n'
      + 'Postmortems are written within three working days and shared with the whole squad before the Friday review. '
      + 'A postmortem names what failed, what the alert missed, and the one change that would have caught it sooner.\n',
  },
];

const OLD_FORMAT_INDEX: KnowledgeFile = {
  path: 'index.md',
  text: `# Knowledge index\n\n${OLD_FORMAT_PAGES.map((page) => `- \`${page.path}\`: ${/description: (.*)/.exec(page.text)![1]}`).join('\n')}\n`,
};

/** Every file of the fake knowledge base, index first. */
export const oldFormatKnowledge = (): KnowledgeFile[] => [OLD_FORMAT_INDEX, ...OLD_FORMAT_PAGES.map((page) => ({ ...page }))];
