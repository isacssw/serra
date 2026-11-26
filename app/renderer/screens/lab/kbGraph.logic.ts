// Graph lab (SERRA-93, prototype): the knowledge base as nodes and edges. Pages are the nodes; the edges are the ones
// Serra can already derive from its files: a page naming another page or person (mentions), two pages written from the
// same meeting or thread (`sources:`), two pages cited by the same reply (logs/knowledge-usage.jsonl), and two rules
// that disagree (knowledge-health's conflicts). The seed below is realistic made-up data, not anyone's profile.
// Pure: no React, Electron or Node values.

export type Area = 'identity' | 'rules' | 'voice' | 'limits' | 'people' | 'processes' | 'projects';

export const AREA_ORDER: readonly Area[] = ['identity', 'rules', 'voice', 'limits', 'people', 'processes', 'projects'];

/** The Overview's names for the areas (src/knowledge-health.ts AREA_LABELS). */
export const AREA_NAMES: Record<Area, string> = {
  identity: 'Who you are', rules: 'How you work', voice: 'How you write', limits: 'Off-limits',
  people: 'People', processes: 'Processes', projects: 'Projects',
};

export type EdgeKind = 'mentions' | 'source' | 'cited' | 'disagrees';

interface GraphNode {
  /** The page path, relative to `knowledge/`. */
  id: string;
  label: string;
  area: Area;
  /** `written:` date, YYYY-MM-DD. */
  written: string;
  /** Replies that cited the page in the last 30 days. */
  uses: number;
  /** A rule on it disagrees with another page. */
  disputed: boolean;
}

interface GraphEdge { a: number; b: number; kind: EdgeKind }

export interface KbGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Node indexes linked to each node. */
  neighbours: number[][];
}

/** A small deterministic random source, so the seed and its layouts are the same on every run. */
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

// path, label, written, uses, links (page ids, short form without .md)
type Row = [string, string, string, number, string[]];

const PAGES: Row[] = [
  ['owner/role', 'Your role', '2026-06-02', 31, ['owner/responsibilities', 'owner/priorities']],
  ['owner/responsibilities', 'What you own', '2026-06-02', 18, ['product/billing', 'workflows/release-checklist', 'people/priya']],
  ['owner/priorities', 'Priorities', '2026-06-03', 22, ['product/billing', 'product/api-v3', 'owner/focus-time']],
  ['owner/reviews', 'Code reviews', '2026-06-03', 26, ['owner/pr-size', 'owner/testing', 'people/felix', 'people/tomas']],
  ['owner/releases', 'Release days', '2026-06-04', 19, ['workflows/deploy', 'workflows/release-checklist', 'decisions/release-train']],
  ['owner/meetings', 'Meetings', '2026-06-05', 9, ['owner/focus-time', 'people/priya', 'people/ruth']],
  ['owner/focus-time', 'Focus time', '2026-06-05', 7, []],
  ['owner/escalation', 'When to escalate', '2026-06-09', 12, ['workflows/incident', 'people/jonas', 'people/ruth']],
  ['owner/dependencies', 'Adding dependencies', '2026-06-12', 8, ['people/ines', 'owner/reviews']],
  ['owner/testing', 'Testing', '2026-06-16', 14, ['people/sara', 'workflows/feature-flags']],
  ['owner/pr-size', 'PR size', '2026-06-18', 11, []],
  ['owner/voice', 'How you write', '2026-06-02', 34, ['owner/voice-slack', 'owner/voice-release-notes']],
  ['owner/voice-slack', 'Slack replies', '2026-06-10', 21, []],
  ['owner/voice-release-notes', 'Release notes', '2026-07-21', 6, ['workflows/release-checklist']],
  ['owner/off-limits', 'Off-limits', '2026-06-02', 3, ['owner/customer-data', 'people/ines']],
  ['owner/customer-data', 'Customer data', '2026-06-24', 5, ['product/analytics', 'workflows/support-handoff']],
  ['people/maya', 'Maya, design', '2026-06-06', 10, ['product/onboarding-flow', 'product/mobile-app']],
  ['people/tomas', 'Tomás, backend', '2026-06-06', 15, ['product/billing', 'product/api-v3', 'decisions/postgres']],
  ['people/priya', 'Priya, product', '2026-06-06', 17, ['product/billing', 'product/search', 'product/onboarding-flow']],
  ['people/jonas', 'Jonas, infra', '2026-06-08', 16, ['workflows/deploy', 'workflows/on-call', 'decisions/monorepo']],
  ['people/lea', 'Lea, support', '2026-06-11', 8, ['workflows/support-handoff', 'workflows/triage']],
  ['people/kenji', 'Kenji, mobile', '2026-06-19', 6, ['product/mobile-app']],
  ['people/sara', 'Sara, QA', '2026-06-19', 9, ['workflows/release-checklist', 'workflows/triage']],
  ['people/omar', 'Omar, data', '2026-07-02', 4, ['product/analytics']],
  ['people/ines', 'Inês, security', '2026-07-02', 7, ['workflows/incident']],
  ['people/felix', 'Felix, frontend', '2026-07-09', 8, ['product/search', 'product/onboarding-flow']],
  ['people/ruth', 'Ruth, CEO', '2026-06-08', 5, []],
  ['people/ade', 'Ade, sales eng', '2026-08-14', 3, ['product/api-v3']],
  ['workflows/deploy', 'Deploys', '2026-06-09', 24, ['workflows/hotfix', 'workflows/feature-flags', 'workflows/migrations']],
  ['workflows/incident', 'Incidents', '2026-06-15', 13, ['workflows/on-call', 'workflows/hotfix']],
  ['workflows/on-call', 'On-call', '2026-06-15', 9, []],
  ['workflows/hotfix', 'Hotfixes', '2026-06-22', 7, []],
  ['workflows/release-checklist', 'Release checklist', '2026-06-23', 14, ['decisions/thursday-releases']],
  ['workflows/triage', 'Bug triage', '2026-07-06', 10, ['workflows/support-handoff']],
  ['workflows/onboarding', 'New joiners', '2026-08-03', 4, ['people/maya', 'people/jonas', 'decisions/monorepo']],
  ['workflows/migrations', 'DB migrations', '2026-07-14', 6, ['decisions/postgres', 'people/tomas']],
  ['workflows/feature-flags', 'Feature flags', '2026-07-28', 8, ['decisions/flags-vendor']],
  ['workflows/support-handoff', 'Support handoff', '2026-08-18', 5, []],
  ['product/billing', 'Billing v2', '2026-06-10', 28, ['product/api-v3', 'decisions/postgres']],
  ['product/search', 'Search', '2026-07-01', 12, ['product/analytics']],
  ['product/mobile-app', 'Mobile app', '2026-07-16', 9, ['product/onboarding-flow']],
  ['product/api-v3', 'API v3', '2026-08-05', 15, ['decisions/monorepo']],
  ['product/onboarding-flow', 'Onboarding flow', '2026-08-20', 7, ['product/analytics']],
  ['product/analytics', 'Analytics', '2026-09-08', 6, []],
  ['decisions/postgres', 'Stay on Postgres', '2026-07-07', 5, []],
  ['decisions/monorepo', 'Monorepo', '2026-08-11', 6, []],
  ['decisions/flags-vendor', 'Flags vendor', '2026-09-15', 3, []],
  ['decisions/release-train', 'Release train', '2026-09-29', 8, ['decisions/thursday-releases']],
  ['decisions/thursday-releases', 'Thursday releases', '2026-11-12', 4, []],
  ['product/pricing', 'Pricing page', '2026-10-06', 5, ['product/billing', 'people/ade']],
  ['workflows/status-page', 'Status page', '2026-10-13', 3, ['workflows/incident']],
  ['product/sso', 'SSO', '2026-10-20', 6, ['people/ines', 'product/api-v3']],
  ['people/noor', 'Noor, product', '2026-10-27', 4, ['product/sso', 'product/pricing']],
  ['decisions/node-24', 'Move to Node 24', '2026-11-03', 3, ['workflows/deploy', 'people/jonas']],
  ['workflows/retro', 'Retros', '2026-11-10', 2, ['owner/meetings']],
  ['product/webhooks', 'Webhooks', '2026-11-17', 3, ['product/api-v3', 'people/tomas']],
  ['owner/oncall-swaps', 'On-call swaps', '2026-11-19', 2, ['workflows/on-call']],
  ['decisions/drop-ie', 'Drop old browsers', '2026-11-24', 1, ['people/felix']],
];

/** Pages written from the same meeting, interview or Slack thread (`sources:`). */
const SOURCES: string[][] = [
  ['owner/role', 'owner/responsibilities', 'owner/voice', 'owner/off-limits'],
  ['owner/releases', 'workflows/deploy', 'people/jonas'],
  ['workflows/incident', 'workflows/on-call', 'owner/escalation'],
  ['product/billing', 'people/tomas', 'people/priya'],
  ['decisions/release-train', 'owner/releases', 'workflows/release-checklist'],
  ['product/sso', 'people/noor', 'people/ines'],
  ['product/mobile-app', 'people/kenji', 'people/maya'],
];

/** Pages one reply cited together. */
const CITED: [string, string][] = [
  ['owner/voice', 'owner/voice-slack'], ['owner/reviews', 'owner/pr-size'], ['owner/releases', 'workflows/release-checklist'],
  ['workflows/deploy', 'workflows/hotfix'], ['owner/priorities', 'product/billing'], ['owner/role', 'owner/voice'],
  ['product/search', 'people/felix'], ['workflows/triage', 'people/lea'], ['owner/testing', 'owner/reviews'],
];

/** Two rules that disagree: the release day (the Overview's "Keep Thursday / Keep Tuesday"). */
const DISAGREE: [string, string][] = [['owner/releases', 'decisions/thursday-releases']];

const areaOf = (path: string): Area => {
  const [folder = '', name = ''] = path.split('/');
  if (/off-limits|customer-data/.test(name)) return 'limits';
  if (folder === 'people') return 'people';
  if (/^voice/.test(name)) return 'voice';
  if (folder === 'owner' && /^(role|responsibilities)$/.test(name)) return 'identity';
  if (folder === 'owner') return 'rules';
  if (folder === 'workflows') return 'processes';
  return 'projects';
};

const withNeighbours = (nodes: GraphNode[], edges: GraphEdge[]): KbGraph => {
  const neighbours: number[][] = nodes.map(() => []);
  for (const { a, b } of edges) {
    if (!neighbours[a]!.includes(b)) neighbours[a]!.push(b);
    if (!neighbours[b]!.includes(a)) neighbours[b]!.push(a);
  }
  return { nodes, edges, neighbours };
};

/** The hand-written knowledge base: about sixty pages, the size of a profile a few months in. */
const smallGraph = (): KbGraph => {
  const nodes: GraphNode[] = PAGES.map(([path, label, written, uses]) => ({
    id: `${path}.md`, label, area: areaOf(path), written, uses, disputed: false,
  }));
  const index = new Map(PAGES.map(([path], i) => [path, i]));
  const at = (path: string): number => {
    const i = index.get(path);
    if (i === undefined) throw new Error(`Seed names an unknown page: ${path}`);
    return i;
  };
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const add = (a: number, b: number, kind: EdgeKind): void => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (a === b || seen.has(key)) return;
    seen.add(key);
    edges.push({ a, b, kind });
  };
  for (const [a, b] of DISAGREE) {
    add(at(a), at(b), 'disagrees');
    nodes[at(a)]!.disputed = true;
    nodes[at(b)]!.disputed = true;
  }
  PAGES.forEach(([path, , , , links]) => { for (const link of links) add(at(path), at(link), 'mentions'); });
  for (const group of SOURCES) for (let i = 1; i < group.length; i++) add(at(group[0]!), at(group[i]!), 'source');
  for (const [a, b] of CITED) add(at(a), at(b), 'cited');
  return withNeighbours(nodes, edges);
};

const TOPICS: Record<Area, string[]> = {
  identity: ['Goals', 'Scope', 'Hiring', 'Budget'],
  rules: ['Reviews', 'Branching', 'Naming', 'Logging', 'Errors', 'Docs', 'Estimates', 'Pairing', 'Standups', 'Approvals', 'Secrets', 'Tooling'],
  voice: ['Emails', 'Changelogs', 'Postmortems', 'Specs', 'Comments'],
  limits: ['Legal', 'Payroll', 'Contracts', 'Health data'],
  people: ['Alex', 'Bea', 'Cai', 'Dani', 'Eli', 'Fen', 'Gus', 'Hana', 'Ivo', 'Jo', 'Kai', 'Lin', 'Mo', 'Nia', 'Oli', 'Pia', 'Raf', 'Sol', 'Tea', 'Uma', 'Vik', 'Wren', 'Xan', 'Yui', 'Zed'],
  processes: ['Rollbacks', 'Backups', 'Access', 'Vendors', 'Audits', 'Dashboards', 'Alerts', 'Runbooks', 'Load tests', 'Canaries', 'Cutovers', 'Handover'],
  projects: ['Exports', 'Imports', 'Teams', 'Invoices', 'Quotas', 'Audit log', 'Themes', 'Payments', 'Search v2', 'Sync', 'Uploads', 'Reports', 'Admin', 'Billing v3', 'CLI', 'SDK'],
};
const SHARE: Record<Area, number> = { identity: 0.02, rules: 0.16, voice: 0.05, limits: 0.02, people: 0.25, processes: 0.2, projects: 0.3 };

const addDays = (date: string, days: number): string => {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};

/**
 * The hand-written base grown to `size` pages, for the 500-1000 node performance check. New pages link mostly inside
 * their area, to well-linked pages first (as real notes do), with one in ten reaching across.
 */
const grownGraph = (size: number): KbGraph => {
  const base = smallGraph();
  const rand = random(93);
  const nodes = [...base.nodes];
  const edges = [...base.edges];
  const degree = nodes.map((_, i) => base.neighbours[i]!.length);
  const byArea = new Map<Area, number[]>(AREA_ORDER.map((area) => [area, []]));
  nodes.forEach((node, i) => byArea.get(node.area)!.push(i));
  const counters = new Map<string, number>();
  // Pages on one topic ("Billing", "Deploys") link to each other most: the clusters a real knowledge base forms.
  const byTopic = new Map<string, number[]>();
  const pick = (pool: number[]): number => {
    let total = 0;
    for (const i of pool) total += degree[i]! + 1;
    let roll = rand() * total;
    for (const i of pool) { roll -= degree[i]! + 1; if (roll <= 0) return i; }
    return pool[pool.length - 1]!;
  };
  const extra = size - nodes.length;
  for (let n = 0; n < extra; n++) {
    let roll = rand();
    let area: Area = 'projects';
    for (const candidate of AREA_ORDER) { roll -= SHARE[candidate]; if (roll <= 0) { area = candidate; break; } }
    const topic = TOPICS[area][Math.floor(rand() * TOPICS[area].length)]!;
    const count = (counters.get(topic) ?? 0) + 1;
    counters.set(topic, count);
    const label = count === 1 ? topic : `${topic} ${count}`;
    const folder = area === 'people' ? 'people' : area === 'processes' ? 'workflows' : area === 'projects' ? 'product' : 'owner';
    const index = nodes.length;
    // Spread over the last half-year, front-loaded like a real start (the interview), then steady.
    const day = Math.floor(Math.pow(rand(), 0.8) * 175);
    nodes.push({
      id: `${folder}/${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`, label, area,
      written: addDays('2026-06-02', day), uses: Math.floor(Math.pow(rand(), 3) * 20), disputed: false,
    });
    degree.push(0);
    const links = 1 + Math.floor(rand() * 2.6);
    const linked = new Set<number>();
    const topicKey = `${area}:${topic}`;
    const sameTopic = byTopic.get(topicKey) ?? [];
    for (let l = 0; l < links; l++) {
      const roll = rand();
      const pool = roll < 0.08 ? nodes.slice(0, index).map((_, i) => i)
        : roll < 0.3 || sameTopic.length === 0 ? byArea.get(area)!
          : sameTopic;
      if (pool.length === 0) continue;
      const target = pick(pool);
      if (linked.has(target)) continue;
      linked.add(target);
      const kind: EdgeKind = rand() < 0.15 ? 'source' : rand() < 0.15 ? 'cited' : 'mentions';
      edges.push({ a: index, b: target, kind });
      degree[index]! += 1;
      degree[target]! += 1;
    }
    byArea.get(area)!.push(index);
    byTopic.set(topicKey, [...sameTopic, index]);
    if (rand() < 0.008 && linked.size > 0) {
      const other = [...linked][0]!;
      edges.push({ a: index, b: other, kind: 'disagrees' });
      nodes[index]!.disputed = true;
      nodes[other]!.disputed = true;
    }
  }
  return withNeighbours(nodes, edges);
};

/** The seed graph: the real-size base (`small`, about 60 pages) or grown to `size` pages. */
export const seedGraph = (size: number | 'small'): KbGraph => (size === 'small' ? smallGraph() : grownGraph(size));

/** Moments on the growth timeline: where pages came from (the interview, meetings) and the weekly reviews. */
export interface Landmark { date: string; label: string; kind: 'interview' | 'meeting' | 'review' }

export const LANDMARKS: readonly Landmark[] = [
  { date: '2026-06-02', label: 'Interview', kind: 'interview' },
  { date: '2026-06-15', label: 'Incident review', kind: 'meeting' },
  { date: '2026-07-07', label: 'Architecture sync', kind: 'meeting' },
  { date: '2026-08-11', label: 'Platform planning', kind: 'meeting' },
  { date: '2026-09-29', label: 'Release planning', kind: 'meeting' },
  { date: '2026-10-27', label: 'SSO kickoff', kind: 'meeting' },
  ...['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23']
    .map((date): Landmark => ({ date, label: 'Weekly review', kind: 'review' })),
];

/** Node indexes ordered by the date they were written, oldest first; ties keep seed order. */
export const growthOrder = (graph: KbGraph): number[] =>
  graph.nodes.map((_, i) => i).sort((a, b) => graph.nodes[a]!.written.localeCompare(graph.nodes[b]!.written) || a - b);

/** The page to centre the radial view on first: the most linked project. */
export const defaultCentre = (graph: KbGraph): number => {
  let best = -1;
  graph.nodes.forEach((node, i) => {
    if (node.area === 'projects' && (best === -1 || graph.neighbours[i]!.length > graph.neighbours[best]!.length)) best = i;
  });
  return Math.max(best, 0);
};
