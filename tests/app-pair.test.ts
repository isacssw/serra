// Add… › Server in the window (SB-32): the pair dialog's steps and words, and the app's `servers` handlers, which
// pass the window's input to the pairing and never hand back a code or token.
import assert from 'node:assert/strict';
import test from 'node:test';
import { serverHandlers } from '../app/main/servers.ts';
import { afterCode, codeComplete, codeInput, pairLine, pairTitle, sshError, wrongCode, type PairStep } from '../app/renderer/shell/pair.logic.ts';
import type { ServerPairing } from '../src/gateway/pairing.ts';
import { SshFailed } from '../src/gateway/ssh.ts';

test('the code field takes the code as it is read off the server: capitals, six, with the dash', () => {
  assert.equal(codeInput('k7q4mx'), 'K7Q-4MX');
  assert.equal(codeInput('K7Q-4MX-extra'), 'K7Q-4MX');
  assert.equal(codeInput(' k7 q '), 'K7Q');
  // 0, O, 1, I and L are never in a code, so they can't be typed by mistake.
  assert.equal(codeInput('O01IL'), '');
  assert.equal(codeComplete('K7Q-4M'), false);
  assert.equal(codeComplete('K7Q-4MX'), true);
});

test('each step has one title and at most one short line, in the rulebook’s words', () => {
  const words: PairStep = { step: 'words', address: 't480', code: 'K7Q-4MX', probeId: 'p', name: 't480', words: ['maple', 'orbit', 'lantern'] };
  assert.equal(pairTitle({ step: 'add' }), 'Add');
  assert.equal(pairTitle({ step: 'address', address: '', code: '', error: null }), 'Add server');
  assert.equal(pairLine({ step: 'address', address: '', code: '', error: null }), 'On the server, run serra server pair.');
  assert.equal(pairTitle(words), 'Pair with t480');
  assert.equal(pairLine(words), 't480 shows three words. Do they match?');
  assert.equal(pairTitle({ step: 'mismatch', name: 't480' }), 'Not paired');
  assert.equal(pairLine({ step: 'mismatch', name: 't480' }), 'The words didn’t match, so nothing was sent.');
  assert.equal(pairLine({ step: 'locked', name: 't480', address: 't480', expired: false }), 'No tries left. Run serra server pair on t480 again.');
  assert.equal(wrongCode(4), 'Wrong or expired code. 4 tries left.');
  assert.equal(wrongCode(1), 'Wrong or expired code. 1 try left.');
  const ready: PairStep = { step: 'ready', server: { id: 's_abc123', name: 't480', via: 'address', profiles: [] } };
  assert.equal(pairTitle(ready), 't480 is ready');
  assert.equal(pairLine(ready), 'No profiles yet');
  for (const step of [words, ready, { step: 'ssh', target: '', error: null } satisfies PairStep]) {
    const line = pairLine(step) ?? '';
    // A6: at most two short sentences.
    assert.ok(line.split(/[.?]\s/).length <= 2 && line.length < 80, line);
  }
});

test('after the code: ready, the code again with tries left (from the words step too), or locked', () => {
  const sent = { address: 't480', name: 't480' };
  const server = { id: 's_abc123', name: 't480', via: 'address' as const, profiles: [] };
  assert.deepEqual(afterCode(sent, { ok: true, server }), { step: 'ready', server });
  // Sent from the words step, a wrong code goes back to the code field, emptied: a new code means new words.
  const wordsStep = { step: 'words' as const, code: 'K7Q-4MX', probeId: 'p1', words: ['maple', 'orbit', 'lantern'], ...sent };
  const back = afterCode(wordsStep, { ok: false, reason: 'wrong', triesLeft: 4 });
  assert.deepEqual(back, { step: 'address', address: 't480', code: '', error: null, codeError: 'Wrong or expired code. 4 tries left.', name: 't480' });
  assert.equal(pairTitle(back), 'Pair with t480');
  assert.deepEqual(afterCode(sent, { ok: false, reason: 'locked' }), { step: 'locked', name: 't480', address: 't480', expired: false });
  assert.deepEqual(afterCode(sent, { ok: false, reason: 'expired' }), { step: 'locked', name: 't480', address: 't480', expired: true });
});

test('a failed SSH pairing says what happened and that nothing changed, naming the server', () => {
  assert.deepEqual(sshError('you@t480.home', 'key refused'), { title: 'Can’t reach t480 over SSH · key refused', line: 'Nothing changed. Check ssh you@t480.home works in Terminal.' });
  assert.equal(sshError('t480', 'timed out').title, 'Can’t reach t480 over SSH · timed out');
  assert.equal(sshError('t480', 'no serra').title, 'Serra isn’t on t480');
  assert.match(sshError('t480', 'no gateway').line, /serra server gateway --install/);
});

test('the app’s servers handlers check the window’s input and turn SSH failures into a few words', async () => {
  const calls: string[] = [];
  const pairing: ServerPairing = {
    probe: (address, code) => { calls.push(`probe ${address} ${code}`); return Promise.resolve({ probeId: 'p1', name: 't480', words: ['maple', 'orbit', 'lantern'] }); },
    pair: (probeId, code) => { calls.push(`pair ${probeId} ${code}`); return Promise.resolve({ ok: false, reason: 'wrong', triesLeft: 4 }); },
    cancel: (probeId) => { calls.push(`cancel ${probeId}`); },
    pairOverSsh: () => Promise.reject(new SshFailed('key refused', 'The server refused this Mac’s SSH key.')),
    list: () => [],
    client: () => { throw new Error('unused'); },
    forget: () => Promise.resolve(),
    close: () => {},
  };
  const handlers = serverHandlers(pairing);
  assert.deepEqual(await handlers.probe(' t480 ', 'K7Q-4MX'), { probeId: 'p1', name: 't480', words: ['maple', 'orbit', 'lantern'] });
  assert.deepEqual(await handlers.pair('p1', 'K7Q-4MX'), { ok: false, reason: 'wrong', triesLeft: 4 });
  await assert.rejects(Promise.resolve().then(() => handlers.probe('', 'K7Q-4MX')), /An address is needed/);
  await assert.rejects(Promise.resolve().then(() => handlers.pair('p1', 'x'.repeat(100))), /The code is needed/);
  assert.deepEqual(await handlers.pairOverSsh('you@t480'), { ok: false, detail: 'key refused', message: 'The server refused this Mac’s SSH key.' });
  await handlers.cancel('p1');
  assert.deepEqual(calls, ['probe t480 K7Q-4MX', 'pair p1 K7Q-4MX', 'cancel p1']);
});
