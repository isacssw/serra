/**
 * Wire-level scenarios. Each `tests/scenarios/*.json` file drives the real daemon (`startDaemon`) only through its
 * boundaries: Slack envelopes in (through Bolt's own middleware), Slack Web API calls and `state.json` out, a scripted
 * T3 worker and a fake clock. A scenario doesn't care how the inside is arranged, so it holds across refactors.
 *
 * Steps (`do`):
 *   slack {envelope, ack?}          deliver an envelope; it must be acked unless `ack: false`
 *   click {label, user}             press the button labelled `label` on the latest card, as `user` (a block_actions envelope)
 *   advance {ms}                    move the clock, firing due timers (the 15 s poll) in order
 *   worker.reply {text} | worker.note {text} | worker.endSilently | worker.startRun | worker.userRun {text} | worker.ask {request}
 *   slack.hang {method} | slack.hangAfter {method} | slack.fail {method, error}
 *   t3.hangStart {later?, made?}    the `later`-th `thread start` from now never returns, after making its thread or (made: false) before
 *   pause | resume                  the app pauses new work for an update, or lifts the pause
 *   restart | crash                 stop cleanly and start again, or abandon the daemon where it is and start again
 *   mark {name}                     remember the position in the Slack call log
 * Expectations (`expect`):
 *   slack: [{method, args?, count?, since?}]   calls to `method` whose args contain `args` (count defaults to at least one)
 *   state: {key: {field: value | "$absent"}}  saved jobs; `"$none"` as the whole value means no job
 *   t3: {started?, sends?, answered?}
 *   logs: [regex]                             daemon log lines that must appear
 *   reactions: {"channel:ts": [names]}
 *   held: n                                   requests waiting in held-requests.jsonl
 *   jobs: {key: group}                        the Jobs screen's group for a job, from saved state
 * A string value `{"$match": "regex"}` matches text by pattern.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pauseIntake, readHeld, resumeIntake } from '../src/intake.ts';
import { listJobs } from '../src/jobs.ts';
import type { T3QuestionRequest } from '../src/t3-questions.ts';
import { startTestDaemon, type DaemonHarness } from './fakes/daemon.ts';
import type { SlackMethod } from './fakes/slack.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Step = { do?: string; expect?: Expectation; [field: string]: Json | Expectation | undefined };
type Expectation = {
  slack?: { method: SlackMethod; args?: Json; count?: number; since?: string }[];
  state?: Record<string, Record<string, Json> | '$none'>;
  t3?: { started?: number; sends?: number; answered?: number };
  reactions?: Record<string, string[]>;
  held?: number;
  jobs?: Record<string, string>;
  logs?: string[];
};
interface Scenario {
  id: string; specs: string[]; title: string; profile?: Record<string, unknown>; steps: Step[];
  /** `failStart`: every `t3 thread start` fails with this error text (as `t3` stderr would read). */
  t3?: { failStart?: string };
  /** `returnsMetadata: false`: Slack leaves message metadata out of thread reads. */
  slack?: { returnsMetadata?: boolean; rewritesText?: boolean };
}

const folder = new URL('./scenarios/', import.meta.url);

/** Whether `actual` contains `expected`: objects by subset, arrays element by element, `$match` by regex. */
const contains = (actual: unknown, expected: Json): boolean => {
  if (expected === '$absent') return actual === undefined;
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    if (typeof expected.$match === 'string') return typeof actual === 'string' && new RegExp(expected.$match, 's').test(actual);
    if (typeof actual !== 'object' || actual === null) return false;
    return Object.entries(expected).every(([key, value]) => contains((actual as Record<string, unknown>)[key], value));
  }
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((value, i) => contains(actual[i], value));
  return actual === expected;
};

/** A block_actions envelope pressing a button on the newest message that has one with this label. */
const click = (h: DaemonHarness, label: string, user: string): Record<string, unknown> => {
  for (const call of h.slack.calls.toReversed()) {
    if (call.method !== 'chat.postMessage' && call.method !== 'chat.update') continue;
    const blocks = Array.isArray(call.args.blocks) ? call.args.blocks as Record<string, unknown>[] : [];
    for (const block of blocks) {
      const elements = Array.isArray(block.elements) ? block.elements as Record<string, unknown>[] : [];
      const button = elements.find((element) => element.type === 'button' && (element.text as { text?: string } | undefined)?.text === label);
      if (!button) continue;
      const ts = call.method === 'chat.update' ? String(call.args.ts) : h.slack.thread(String(call.args.channel), String(call.args.thread_ts)).find((message) => JSON.stringify(message.blocks) === JSON.stringify(call.args.blocks))?.ts;
      return {
        type: 'block_actions', team: { id: 'THOME' }, user: { id: user, team_id: 'THOME' }, api_app_id: 'A1', token: 'x', trigger_id: 't',
        channel: { id: call.args.channel }, container: { type: 'message', message_ts: ts, channel_id: call.args.channel },
        message: { ts, type: 'message' }, actions: [{ type: 'button', action_id: button.action_id, block_id: block.block_id, value: button.value, action_ts: '1' }],
      };
    }
  }
  throw new Error(`No button labelled ${label}`);
};

const check = async (h: DaemonHarness, expect: Expectation, marks: Map<string, number>, where: string): Promise<void> => {
  for (const want of expect.slack ?? []) {
    const from = want.since ? marks.get(want.since) ?? assert.fail(`${where}: no mark ${want.since}`) : 0;
    const found = h.slack.calls.slice(from).filter((call) => call.method === want.method && (want.args === undefined || contains(call.args, want.args)));
    const detail = `${where}: ${want.method} ${JSON.stringify(want.args ?? {})}\ncalls: ${JSON.stringify(h.slack.calls.slice(from).filter((call) => call.method === want.method).map((call) => call.args), null, 1).slice(0, 3000)}`;
    if (want.count === undefined) assert.ok(found.length > 0, detail);
    else assert.equal(found.length, want.count, detail);
  }
  const state = h.state();
  for (const [key, fields] of Object.entries(expect.state ?? {})) {
    if (fields === '$none') { assert.equal(state[key], undefined, `${where}: no job ${key}`); continue; }
    const job = state[key] as unknown as Record<string, unknown> | undefined;
    assert.ok(job, `${where}: a job ${key} is saved`);
    for (const [field, value] of Object.entries(fields)) assert.ok(contains(job[field], value), `${where}: ${key}.${field} is ${JSON.stringify(job[field])}, expected ${JSON.stringify(value)}`);
  }
  if (expect.t3?.started !== undefined) assert.equal(h.t3.started.length, expect.t3.started, `${where}: T3 threads started`);
  if (expect.t3?.sends !== undefined) assert.equal(h.t3.sends.length, expect.t3.sends, `${where}: turns sent to T3`);
  if (expect.t3?.answered !== undefined) assert.equal(h.t3.answered.length, expect.t3.answered, `${where}: questions answered in T3`);
  for (const [at, names] of Object.entries(expect.reactions ?? {})) {
    const [channel, ts] = at.split(':') as [string, string];
    assert.deepEqual(h.slack.reactionsOn(channel, ts).sort(), [...names].sort(), `${where}: reactions on ${at}`);
  }
  for (const pattern of expect.logs ?? []) assert.ok(h.logs.some((line) => new RegExp(pattern).test(line)), `${where}: a log line matches ${pattern}`);
  if (expect.held !== undefined) assert.equal(readHeld(h.config.profileDir).length, expect.held, `${where}: held requests`);
  if (expect.jobs) {
    const listing = await listJobs(h.config.profileDir, { doneTodayOnly: false, now: new Date(h.clock.now()) });
    for (const [key, group] of Object.entries(expect.jobs)) {
      assert.equal(listing.jobs.find((job) => job.key === key)?.group, group, `${where}: Jobs shows ${key} as ${group}`);
    }
  }
};

const run = async (h: DaemonHarness, scenario: Scenario): Promise<void> => {
  // The scenario's top-level `slack` and `t3` are options, not steps.
  const marks = new Map<string, number>();
  for (const [index, step] of scenario.steps.entries()) {
    const where = `${scenario.id} step ${index + 1}${step.do ? ` (${step.do})` : ''}`;
    const text = typeof step.text === 'string' ? step.text : '';
    const method = step.method as SlackMethod;
    switch (step.do) {
      case undefined: break;
      case 'slack': {
        const { acked } = await h.deliver(step.envelope as Record<string, unknown>);
        assert.equal(acked, step.ack !== false, `${where}: acked`);
        break;
      }
      case 'click': {
        const { acked } = await h.deliver(click(h, String(step.label), String(step.user)));
        assert.ok(acked, `${where}: the button press is acked`);
        break;
      }
      case 'advance': await h.advance(Number(step.ms)); break;
      case 'worker.reply': h.t3.reply(text); break;
      case 'worker.note': h.t3.note(text); break;
      case 'worker.endSilently': h.t3.endSilently(); break;
      case 'worker.startRun': h.t3.startRun(); break;
      case 'worker.userRun': h.t3.userRun(text); break;
      case 'worker.ask': h.t3.ask(step.request as unknown as T3QuestionRequest); break;
      case 'slack.hang': h.slack.hang(method); break;
      case 't3.hangStart': h.t3.hangStart(typeof step.later === 'number' ? step.later : 1, step.made !== false); break;
      case 'slack.hangAfter': h.slack.hangAfter(method); break;
      case 'slack.fail': h.slack.fail(method, String(step.error)); break;
      case 'pause': pauseIntake(h.config.profileDir, 'app-update', { now: h.clock.now() }); break;
      case 'resume': resumeIntake(h.config.profileDir); break;
      case 'restart': await h.restart(); break;
      case 'crash': await h.crash(); break;
      case 'mark': marks.set(String(step.name), h.slack.calls.length); break;
      default: assert.fail(`${where}: unknown step`);
    }
    if (step.expect) await check(h, step.expect, marks, where);
  }
};

for (const file of readdirSync(folder).filter((name) => name.endsWith('.json')).sort()) {
  const scenario = JSON.parse(readFileSync(join(folder.pathname, file), 'utf8')) as Scenario;
  test(`${scenario.specs.map((id) => `[${id}]`).join('')} ${scenario.title}`, async (t) => {
    t.diagnostic(`scenarioId=${scenario.id}`);
    const failStart = scenario.t3?.failStart;
    const h = await startTestDaemon(t, {
      ...(scenario.profile ? { profile: scenario.profile } : {}),
      ...(failStart ? { t3: { failStart: () => new Error(failStart) } } : {}),
      ...(scenario.slack ? { slack: scenario.slack } : {}),
    });
    await run(h, scenario);
  });
}
