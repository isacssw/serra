import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { shareImages } from '../src/images.ts';
import { slackUpload } from './fakes/chat.ts';
import { createFakeSlack } from './fakes/slack.ts';

const thread = { conversation: 'C1', thread: '1.0' };

/** A folder in /tmp (allowed for images and files) and a Slack client that records uploads. */
const fixture = (t: TestContext, { fail = false, base = '/tmp' } = {}) => {
  const root = realpathSync(mkdtempSync(join(base, 'bots-images-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const slack = createFakeSlack();
  if (fail) slack.fail('filesUploadV2', new Error('upload refused'), Infinity);
  const { client } = slack;
  const file = (name: string, bytes: string | Buffer = 'content'): string => {
    const path = join(root, name);
    writeFileSync(path, bytes);
    return path;
  };
  /** Uploads Slack accepted. */
  return { root, client, upload: slackUpload(client, thread), file, get uploads() { return fail ? [] : slack.callsTo('filesUploadV2'); } };
};

test('uploads a linked local HTML deliverable and says it is attached', async (t) => {
  const f = fixture(t);
  const html = f.file('preview.html', '<html></html>');
  const text = `Done.\n[Download v5 and play offline](${html})\nThanks.`;
  const shared = await shareImages(text, f.upload);
  assert.equal(shared, 'Done.\nDownload v5 and play offline _(attached above)_\nThanks.');
  assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0]?.file, html);
  assert.equal(f.uploads[0]?.filename, 'preview.html');
  assert.equal(f.uploads[0]?.title, 'Download v5 and play offline');
  assert.equal(f.uploads[0]?.channel_id, 'C1');
  assert.equal(f.uploads[0]?.thread_ts, '1.0');
});

test('uploads PDF, ZIP and text files, including bracketed paths with spaces, once each', async (t) => {
  const f = fixture(t);
  const pdf = f.file('report.pdf');
  const zip = f.file('my build.zip');
  const csv = f.file('data.CSV');
  const text = `[report](${pdf}) and [build](<${zip}>) and [${csv}](${csv}) and again [the report](${pdf})`;
  const shared = await shareImages(text, f.upload);
  assert.equal(shared, 'report _(attached above)_ and build _(attached above)_ and data.CSV _(attached above)_ and again the report _(attached above)_');
  assert.deepEqual(f.uploads.map((upload) => upload.file), [pdf, zip, csv]);
});

test('leaves links alone when the file is missing, too big, the wrong type or outside the allowed folders', async (t) => {
  const f = fixture(t);
  const big = f.file('big.zip', Buffer.alloc(25 * 1024 * 1024 + 1));
  const code = f.file('index.ts');
  const outside = `${homedir()}/Documents/not-shared-${process.pid}.html`;
  const text = [
    `[missing](${f.root}/missing.html)`,
    `[big](${big})`,
    `[code](${code})`,
    `[outside](${outside})`,
    `[position](${code}:12)`,
    '[web](https://example.com/a.html)',
  ].join('\n');
  assert.equal(await shareImages(text, f.upload), text);
  assert.equal(f.uploads.length, 0);
});

test('a failed upload keeps the link as it was', async (t) => {
  const f = fixture(t, { fail: true });
  const text = `[report](${f.file('report.pdf')})`;
  assert.equal(await shareImages(text, f.upload), text);
});

test('caps file uploads per reply and leaves the rest as links', async (t) => {
  const f = fixture(t);
  const links = [1, 2, 3, 4, 5].map((n) => `[file ${n}](${f.file(`f${n}.txt`)})`);
  const shared = await shareImages(links.join('\n'), f.upload);
  assert.equal(f.uploads.length, 4);
  assert.match(shared, /^file 4 _\(attached above\)_$/m);
  assert.ok(shared.includes(links[4]!));
});

test('images still become notes, and a file linked next to an image is uploaded too', async (t) => {
  const f = fixture(t);
  const png = f.file('shot.png');
  const html = f.file('page.html');
  const shared = await shareImages(`![Shot](${png})\n[Page](${html})\n![Missing](${f.root}/nope.png)`, f.upload);
  assert.equal(shared, '_(image attached above: Shot)_\nPage _(attached above)_\n_(image "Missing" not attached: file not found)_');
  assert.deepEqual(f.uploads.map((upload) => upload.file), [png, html]);
  assert.equal(f.uploads[0]?.alt_text, 'Shot');
  assert.equal(f.uploads[1]?.alt_text, undefined);
});

test('returns text without local links untouched and makes no calls', async (t) => {
  const f = fixture(t);
  const text = 'No files here, just [a link](https://example.com).';
  assert.equal(await shareImages(text, f.upload), text);
  assert.equal(f.uploads.length, 0);
});

test('a file in the per-user temp folder is not uploaded, though an image there still is', { skip: realpathSync(tmpdir()).startsWith(realpathSync('/tmp')) }, async (t) => {
  const f = fixture(t, { base: tmpdir() });
  const report = f.file('report.html', '<p>x</p>');
  const shot = f.file('shot.png', 'png');
  const text = await shareImages(`[Report](${report}) ![Shot](${shot})`, f.upload);
  assert.equal(f.uploads.length, 1);
  assert.match(text, /\[Report\]\(/);
});

test('each upload is checked right before it goes out: once the check fails, nothing more is uploaded', async (t) => {
  const f = fixture(t);
  const [a, b, c] = [f.file('a.png'), f.file('b.png'), f.file('c.html', '<html></html>')];
  let checks = 0;
  const shared = await shareImages(`![](${a})\n![](${b})\n[report](${c})`, slackUpload(f.client, thread, () => ++checks === 1));
  assert.equal(f.uploads.length, 1, 'only the upload before the change went out');
  assert.equal(f.uploads[0]?.file, a);
  assert.ok(checks >= 2);
  assert.doesNotMatch(shared, /report _\(attached above\)_/);
});
