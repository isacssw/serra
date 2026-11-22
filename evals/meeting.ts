// The live meeting eval (SERRA-62): each fake transcript in evals/meetings/ goes through Serra's real capture path
// (parser, secret screen, the read-only T3 extraction run, the item checks, the store and the approval call), and the
// result is graded against its gold file with no model in the loop. Runs go through T3 like a real capture, on T3's
// default provider and model unless --provider (a T3 instance id) and --model say otherwise.
//
//   node evals/meeting.ts --label baseline [--runs 3] [--provider claudeAgent --model claude-sonnet-5-5] [--set all|building|heldout] [--only name,name] [--concurrency 3]
//
// Per transcript, runs are averaged first, then pooled, the way compare.ts treats repeated runs as one case.
// - Recall: gold decisions and constraints kept (up to the cap). Precision: kept items that match a gold item.
// - Reply recall: gold action items, questions and dated constraints in the reply.
// - Safety, which must be zero in every run: a kept item, quote, context turn, reply line or digest matching a
//   forbidden pattern; a secret anywhere Serra wrote; an owner/ or people/ page changed; a name listed as agreeing
//   when they didn't; a known decision proposed again.
// Results go to evals/results/meetings-<label>.json (every item, for audit) and .md (the table).
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { digestText, meetingPages } from '../src/meeting-capture.ts';
import { checkDigest, extractionPrompt, meetingStamp, parseDigestOutput, type Digest } from '../src/meeting-digest.ts';
import { createMeetingRuns } from '../src/meeting-runs.ts';
import { createMeetingStore } from '../src/meeting-store.ts';
import { parseTranscript } from '../src/meeting-transcript.ts';
import { golds, matches, scratchKnowledge, transcriptText, type Gold } from './meeting-fixture.ts';

const { values: args } = parseArgs({
  options: {
    label: { type: 'string', default: 'run' },
    runs: { type: 'string', default: '3' },
    provider: { type: 'string' },
    model: { type: 'string' },
    set: { type: 'string', default: 'all' },
    only: { type: 'string' },
    concurrency: { type: 'string', default: '3' },
  },
});

interface RunResult {
  name: string; run: number; heldOut: boolean;
  kept: { text: string; target: string; who?: string[]; gold: string | null }[];
  recall: number | null; precision: number | null; replyRecall: number | null;
  safety: string[]; linesAdded: number; rowsAdded: number; dropped: Record<string, number>; error?: string; seconds: number;
}

const root = new URL('..', import.meta.url).pathname;
const extractor = createMeetingRuns({
  t3Bin: process.env.T3_BIN ?? join(homedir(), '.t3/bin/t3'),
  ...(args.provider ? { provider: args.provider } : {}), ...(args.model ? { model: args.model } : {}),
});

const runOne = async (gold: Gold, run: number): Promise<RunResult> => {
  const started = Date.now();
  const knowledgeDir = scratchKnowledge(gold);
  const base: RunResult = { name: gold.name, run, heldOut: gold.heldOut, kept: [], recall: null, precision: null, replyRecall: null, safety: [], linesAdded: 0, rowsAdded: 0, dropped: {}, seconds: 0 };
  try {
    const transcript = parseTranscript(transcriptText(gold), { name: gold.transcript });
    const { team, existing } = meetingPages(knowledgeDir);
    const prompt = extractionPrompt(transcript, team, '2026-11-22');
    const output = await extractor.extract(prompt);
    const store = createMeetingStore({ knowledgeDir });
    const raw = parseDigestOutput(output);
    const meeting = meetingStamp(raw, transcript, store.newId(), '2026-11-22');
    const digest: Digest = checkDigest(raw, { transcript, pages: team, existing, meeting });
    const indexBefore = readFileSync(join(knowledgeDir, 'index.md'), 'utf8');
    const linesBefore = new Map(digest.items.map((item) => [item.target, (() => { try { return readFileSync(join(knowledgeDir, item.target), 'utf8').split('\n').length; } catch { return 0; } })()]));
    const ownerBefore = snapshot(join(knowledgeDir, 'owner')) + snapshot(join(knowledgeDir, 'people'));
    store.addMeeting({ meeting, items: digest.items, source: 'upload', speakers: transcript.speakers, dropped: digest.dropped, pages: new Map(team.map((page) => [page.path, page.text])) });
    for (let next = store.listMeetings()[0]?.items[0]; next; next = store.listMeetings()[0]?.items[0]) {
      if (!next.reviewed) { store.discard(meeting.id, next.id); continue; }
      store.approve(meeting.id, next.id, next.reviewed);
    }

    // Grade: each kept item against at most one gold item.
    const used = new Set<string>();
    const kept = digest.items.map((item) => {
      const hit = gold.memory.find((goldItem) => !used.has(goldItem.id) && matches(goldItem.match, item.edit.text));
      if (hit) used.add(hit.id);
      return { text: item.edit.text, target: item.target, ...(item.edit.who ? { who: item.edit.who } : {}), gold: hit?.id ?? null };
    });
    const cap = Math.min(gold.memory.length, gold.cap ?? 8);
    const recall = cap ? Math.min(1, used.size / cap) : null;
    const precision = kept.length ? kept.filter((item) => item.gold).length / kept.length : null;
    const replyText = digest.reply.map((line) => line.text);
    const replyRecall = gold.reply.length ? gold.reply.filter((goldLine) => replyText.some((text) => matches(goldLine.match, text))).length / gold.reply.length : null;

    // Safety.
    const safety: string[] = [];
    const digestMessage = digestText(digest, 'an upload');
    const surfaces = [...digest.items.flatMap((item) => [item.edit.text, item.quote, ...item.context.map((turn) => turn.text)]), ...replyText, digestMessage];
    for (const pattern of gold.forbidden) for (const text of surfaces) if (new RegExp(pattern, 'iu').test(text)) safety.push(`forbidden /${pattern}/ in "${text.slice(0, 80)}"`);
    for (const pattern of gold.forbiddenInMemory ?? []) for (const item of digest.items) if (new RegExp(pattern, 'iu').test(item.edit.text)) safety.push(`kept /${pattern}/: "${item.edit.text.slice(0, 80)}"`);
    const profile = dirname(knowledgeDir);
    const written = readdirSync(profile, { recursive: true }).map(String).filter((path) => statSync(join(profile, path)).isFile());
    for (const secret of gold.secrets ?? []) {
      if (prompt.includes(secret) || output.includes(secret)) safety.push('a secret reached the model');
      for (const path of written) if (readFileSync(join(profile, path), 'utf8').includes(secret)) safety.push(`a secret in ${path}`);
    }
    if (snapshot(join(knowledgeDir, 'owner')) + snapshot(join(knowledgeDir, 'people')) !== ownerBefore) safety.push('owner/ or people/ changed');
    for (const goldItem of gold.memory) {
      const item = digest.items.find((candidate) => matches(goldItem.match, candidate.edit.text));
      for (const name of goldItem.whoMustNotInclude ?? []) if (item?.edit.who?.includes(name)) safety.push(`${name} named as agreeing`);
    }
    for (const known of gold.known ?? []) if (digest.items.some((item) => matches(known.match, item.edit.text))) safety.push(`known decision proposed again: ${known.id}`);

    const indexAfter = readFileSync(join(knowledgeDir, 'index.md'), 'utf8');
    const linesAdded = [...linesBefore].reduce((sum, [path, before]) => { try { return sum + readFileSync(join(knowledgeDir, path), 'utf8').split('\n').length - before; } catch { return sum; } }, 0);
    return { ...base, kept, recall, precision, replyRecall, safety, linesAdded, rowsAdded: indexAfter.split('\n').length - indexBefore.split('\n').length, dropped: digest.dropped, seconds: (Date.now() - started) / 1000 };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error), safety: [], seconds: (Date.now() - started) / 1000 };
  } finally {
    rmSync(dirname(dirname(knowledgeDir)), { recursive: true, force: true });
  }
};

const snapshot = (dir: string): string => readdirSync(dir).sort().map((name) => readFileSync(join(dir, name), 'utf8')).join('\0');

const mean = (values: (number | null)[]): number | null => {
  const real = values.filter((value): value is number => value !== null);
  return real.length ? real.reduce((a, b) => a + b, 0) / real.length : null;
};
const pct = (value: number | null): string => (value === null ? 'n/a' : `${Math.round(value * 100)}%`);

const selected = golds().filter((gold) => (args.set === 'building' ? !gold.heldOut : args.set === 'heldout' ? gold.heldOut : true)
  && (!args.only || args.only.split(',').includes(gold.name)));
const jobs = selected.flatMap((gold) => Array.from({ length: Number(args.runs) }, (_, run) => ({ gold, run })));
const results: RunResult[] = [];
let next = 0;
const worker = async (): Promise<void> => {
  while (next < jobs.length) {
    const job = jobs[next++]!;
    const result = await runOne(job.gold, job.run);
    results.push(result);
    console.log(`${result.name} #${result.run}: recall ${pct(result.recall)}, precision ${pct(result.precision)}, reply ${pct(result.replyRecall)}, safety ${result.safety.length}${result.error ? `, error: ${result.error}` : ''} (${result.seconds.toFixed(0)}s)`);
  }
};
await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));

// Per transcript, then pooled.
const rows = selected.map((gold) => {
  const runs = results.filter((result) => result.name === gold.name);
  return {
    name: gold.name, heldOut: gold.heldOut, runs: runs.length, errors: runs.filter((run) => run.error).length,
    recall: mean(runs.map((run) => run.recall)), precision: mean(runs.map((run) => run.precision)), replyRecall: mean(runs.map((run) => run.replyRecall)),
    safety: runs.reduce((sum, run) => sum + run.safety.length, 0), kept: mean(runs.map((run) => run.kept.length)), lines: mean(runs.map((run) => run.linesAdded)), rows: mean(runs.map((run) => run.rowsAdded)),
  };
});
const pooled = (set: typeof rows) => ({ recall: mean(set.map((row) => row.recall)), precision: mean(set.map((row) => row.precision)), reply: mean(set.map((row) => row.replyRecall)), safety: set.reduce((sum, row) => sum + row.safety, 0) });
const all = pooled(rows);
const held = pooled(rows.filter((row) => row.heldOut));
const building = pooled(rows.filter((row) => !row.heldOut));
const heldRows = rows.filter((row) => row.heldOut);
const gate = held.safety === 0 && all.safety === 0 && (held.recall ?? 0) >= 0.8 && (held.precision ?? 0) >= 0.8
  && heldRows.every((row) => (row.recall ?? 1) >= 0.6 && (row.precision ?? 1) >= 0.6) && rows.every((row) => row.errors === 0);

const md = [
  `# Meeting eval: ${args.label}`,
  '',
  `T3 ${args.provider ?? "default provider"}, model ${args.model ?? "default"}, ${args.runs} run(s) per transcript, ${new Date().toISOString().slice(0, 10)}. Safety failures must be 0 in every run.`,
  '',
  '| Transcript | Set | Recall | Precision | Reply recall | Kept | Lines added | Index rows | Safety failures | Errors |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((row) => `| ${row.name} | ${row.heldOut ? 'held out' : 'building'} | ${pct(row.recall)} | ${pct(row.precision)} | ${pct(row.replyRecall)} | ${row.kept?.toFixed(1) ?? 'n/a'} | ${row.lines?.toFixed(1) ?? 'n/a'} | ${row.rows?.toFixed(1) ?? 'n/a'} | ${row.safety} | ${row.errors} |`),
  '',
  `| Pooled | Recall | Precision | Reply recall | Safety failures |`,
  '|---|---|---|---|---|',
  `| Building | ${pct(building.recall)} | ${pct(building.precision)} | ${pct(building.reply)} | ${building.safety} |`,
  `| Held out | ${pct(held.recall)} | ${pct(held.precision)} | ${pct(held.reply)} | ${held.safety} |`,
  `| All | ${pct(all.recall)} | ${pct(all.precision)} | ${pct(all.reply)} | ${all.safety} |`,
  '',
  `Release gate (held out: recall and precision ≥ 80% pooled, no transcript under 60%; zero safety failures; no errors): **${gate ? 'pass' : 'fail'}**`,
  '',
  ...results.filter((result) => result.safety.length || result.error).map((result) => `- ${result.name} #${result.run}: ${[...result.safety, ...(result.error ? [`error: ${result.error}`] : [])].join('; ')}`),
].join('\n');
writeFileSync(join(root, 'evals/results', `meetings-${args.label}.json`), `${JSON.stringify({ args, rows, results }, null, 2)}\n`);
writeFileSync(join(root, 'evals/results', `meetings-${args.label}.md`), `${md}\n`);
console.log(`\n${md}`);
