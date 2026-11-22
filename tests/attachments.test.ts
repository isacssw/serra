import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { MAX_ATTACHMENT_BYTES, receiveAttachments } from '../src/slack/attachments.ts';
import { createFakeSlack } from './fakes/slack.ts';

const fixture = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'bots-attachments-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lookups: string[] = [];
  const file = { id: 'F1', name: '../../image.png', mimetype: 'image/png', url_private: 'https://files.slack.com/private/image.png' };
  const slack = createFakeSlack({ files: { F1: file } });
  slack.before('files.info', (args) => { lookups.push(String(args.file)); });
  const { client } = slack;
  return { root, client, file, lookups };
};

test('hydrates file IDs, stores actual bytes privately, and reuses safe cache paths', async (t) => {
  const f = fixture(t);
  let downloads = 0;
  const fetchFile: typeof fetch = async (_url, options) => {
    downloads++;
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer secret-token');
    assert.equal(options?.redirect, 'manual');
    assert.ok(options?.signal);
    return new Response('image bytes');
  };
  const text = await receiveAttachments(f.client, [{ id: 'F1' }], f.root, 'secret-token', { fetchFile });
  const files = readdirSync(join(f.root, 'attachments'));
  assert.equal(files.length, 1);
  const path = join(f.root, 'attachments', files[0]!);
  assert.equal(readFileSync(path, 'utf8'), 'image bytes');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.root, 'attachments')).mode & 0o777, 0o700);
  assert.match(text, /image-viewing tool/);
  assert.match(text, /file-only message still needs acknowledgement/);
  assert.ok(text.includes(path));
  assert.doesNotMatch(text, /secret-token|https:\/\//);
  await receiveAttachments(f.client, [f.file], f.root, 'secret-token', { fetchFile });
  assert.equal(downloads, 1);
  assert.deepEqual(f.lookups, ['F1']);
});

test('never sends credentials to external URLs or redirects', async (t) => {
  const f = fixture(t);
  let requests = 0;
  const fetchFile: typeof fetch = async () => { requests++; return new Response(null, { status: 302, headers: { location: 'https://evil.test/steal' } }); };
  for (const url of ['https://evil.test/a', 'https://files.slack.com.evil.test/a', 'http://files.slack.com/a', 'https://user:pass@files.slack.com/a']) {
    const text = await receiveAttachments(f.client, [{ ...f.file, url_private: url }], f.root, 'secret-token', { fetchFile });
    assert.match(text, /unavailable/);
  }
  assert.equal(requests, 0);
  const external = await receiveAttachments(f.client, [{ ...f.file, is_external: true }], f.root, 'secret-token', { fetchFile });
  assert.match(external, /externally hosted/);
  const redirect = await receiveAttachments(f.client, [f.file], f.root, 'secret-token', { fetchFile });
  assert.match(redirect, /unsupported Slack download redirect/);
  assert.equal(requests, 1, 'no request to the redirect target');
});

test('allows a bounded same-host redirect and reports HTTP failures without leaking response content', async (t) => {
  const f = fixture(t);
  const seen: string[] = [];
  const fetchFile: typeof fetch = async (url) => {
    seen.push(String(url));
    return seen.length === 1 ? new Response(null, { status: 302, headers: { location: '/download/image.png' } }) : new Response('bytes');
  };
  assert.match(await receiveAttachments(f.client, [f.file], f.root, 'secret', { fetchFile }), /local path/);
  assert.deepEqual(seen, [f.file.url_private, 'https://files.slack.com/download/image.png']);
  const text = await receiveAttachments(f.client, [{ ...f.file, id: 'F2' }], f.root, 'secret', { fetchFile: async () => new Response('secret body', { status: 403 }) });
  assert.match(text, /HTTP 403/);
  assert.doesNotMatch(text, /secret body/);
});

test('rejects excessive size from metadata, Content-Length and an unbounded stream', async (t) => {
  const f = fixture(t);
  let requests = 0;
  const response = (headers = {}): typeof fetch => async () => { requests++; return new Response(new Uint8Array(MAX_ATTACHMENT_BYTES + 1), { headers }); };
  const metadata = await receiveAttachments(f.client, [{ ...f.file, size: MAX_ATTACHMENT_BYTES + 1 }], f.root, 'secret', { fetchFile: response() });
  assert.match(metadata, /20 MiB/); assert.equal(requests, 0);
  assert.match(await receiveAttachments(f.client, [f.file], f.root, 'secret', { fetchFile: response({ 'content-length': String(MAX_ATTACHMENT_BYTES + 1) }) }), /20 MiB/);
  assert.match(await receiveAttachments(f.client, [f.file], f.root, 'secret', { fetchFile: response() }), /20 MiB/);
  assert.equal(readdirSync(join(f.root, 'attachments')).length, 0, 'no partial files remain');
});

test('per-file failures and count limits preserve the message and never expose raw fetch errors', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const text = await receiveAttachments(f.client, Array.from({ length: 6 }, (_, index) => ({ ...f.file, id: `F${index}` })), f.root, 'secret-token', {
    fetchFile: async () => { calls++; throw new Error('request Authorization Bearer secret-token failed'); },
  });
  assert.equal(calls, 5);
  assert.equal((text.match(/unavailable/g) ?? []).length, 6);
  assert.match(text, /files:read/);
  assert.match(text, /download limit reached/);
  assert.doesNotMatch(text, /secret-token/);
});
