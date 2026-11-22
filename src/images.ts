import { realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, sep } from 'node:path';
import type { SlackApi } from './slack-api.ts';

type SlackClient = Pick<SlackApi, 'filesUploadV2'>;

/**
 * A Markdown image with an absolute local path, the way `show-visually` and the QA skills hand back an image or a video.
 * The path may be wrapped in `<…>`, which Markdown uses when it has spaces.
 */
const LOCAL_IMAGE = /!\[([^\]]*)\]\((?:<(\/[^>\n]+)>|(\/[^)\s]+))\)/g;
const IMAGE_TYPES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const VIDEO_TYPES = new Set(['.mp4', '.mov', '.webm']);
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_IMAGES = 6;

/**
 * A plain Markdown link (not an image) to an absolute local path, the way workers hand back a deliverable:
 * `[Download v5](/Users/…/qa-runs/…/preview.html)`. Only the file types below are uploaded.
 */
const LOCAL_FILE_LINK = /(?<!!)\[([^\]\n]+)\]\((?:<(\/[^>\n]+)>|(\/[^)\s]+))\)/g;
const FILE_TYPES = new Set(['.html', '.htm', '.pdf', '.zip', '.csv', '.txt', '.md']);
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 4;

const realRoots = (roots: string[]): string[] => roots.flatMap((root) => {
  try {
    return [realpathSync(root)];
  } catch {
    return [];
  }
});

/**
 * Where workers write images: generated images, their worktrees, QA run records and temp files.
 * Anything else on the Mac is never uploaded, whatever path a reply names.
 */
const ALLOWED_ROOTS = realRoots([
  `${homedir()}/.codex/generated_images`,
  `${homedir()}/.t3/worktrees`,
  `${homedir()}/.claude/qa-runs`,
  `${homedir()}/.codex/qa-runs`,
  tmpdir(),
  '/tmp',
  '/private/tmp',
  '/private/var/folders',
]);

/**
 * Where a linked deliverable (HTML, PDF, ZIP, text) may come from: QA runs, worktrees and /tmp. Narrower than images,
 * since any file type goes: the per-user temp area (macOS `/var/folders`) holds other programs' files.
 */
const FILE_ROOTS = realRoots([
  `${homedir()}/.t3/worktrees`,
  `${homedir()}/.claude/qa-runs`,
  `${homedir()}/.codex/qa-runs`,
  '/tmp',
  '/private/tmp',
]);

/** The real path of `path` when it lies under an allowed root and is at most `max` bytes, or the reason it can't be shared. */
const checkShareable = (path: string, max: number, roots = ALLOWED_ROOTS): { path: string } | { problem: string } => {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { problem: 'file not found' };
  }
  if (!roots.some((root) => real.startsWith(`${root}${sep}`))) return { problem: 'outside the folders the bot shares from' };
  const stats = statSync(real);
  if (!stats.isFile()) return { problem: 'not a file' };
  if (stats.size > max) return { problem: `${Math.round(stats.size / 1024 / 1024)} MB, over the ${max / 1024 / 1024} MB limit` };
  return { path: real };
};

/** The real path of an image a worker may share, or the reason it can't be shared. */
const checkImage = (path: string): { path: string } | { problem: string } => {
  const type = extname(path).toLowerCase();
  const isVideo = VIDEO_TYPES.has(type);
  if (!isVideo && !IMAGE_TYPES.has(type)) return { problem: 'not an image or video file' };
  return checkShareable(path, isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES);
};

/** Uploads one file into the thread. Returns the error instead of throwing, so one failed upload doesn't lose the reply. */
const upload = async (
  client: SlackClient,
  thread: { channel: string; threadTs: string },
  path: string,
  label: string,
  altText?: string,
): Promise<Error | null> => {
  const result = await client
    .filesUploadV2({
      channel_id: thread.channel,
      thread_ts: thread.threadTs,
      file: path,
      filename: basename(path),
      title: label,
      ...(altText ? { alt_text: altText } : {}),
    })
    .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  return result instanceof Error ? result : null;
};

/**
 * Uploads the local images a reply embeds into the Slack thread, and replaces each embed with a short note,
 * since Slack can't show a path on the owner's machine.
 * Plain links to a local HTML, PDF, ZIP or text deliverable are uploaded too, and become `label (attached above)`.
 * A link that can't be shared stays as it is, for `localLinksToText` to turn into plain text.
 * Returns the reply to post as text.
 */
export const shareImages = async (
  client: SlackClient,
  text: string,
  thread: { channel: string; threadTs: string; mayPost?: () => Promise<boolean> },
): Promise<string> => {
  // Checked right before each upload: one file going out must not carry the next past a change.
  let stopped = false;
  const mayUpload = async (): Promise<boolean> => !stopped && (!thread.mayPost || (await thread.mayPost()) || ((stopped = true), false));
  const embeds = [...text.matchAll(LOCAL_IMAGE)];
  const links = [...text.matchAll(LOCAL_FILE_LINK)].filter(([, , bracketed, plain]) =>
    FILE_TYPES.has(extname(bracketed ?? plain ?? '').toLowerCase()),
  );
  if (embeds.length === 0 && links.length === 0) return text;

  /** Real paths already uploaded by this reply, images and files alike, so nothing is posted twice. */
  const sent = new Set<string>();

  const notes = new Map<string, string>();
  let images = 0;
  for (const [embed, alt, bracketed, plain] of embeds) {
    const path = bracketed ?? plain;
    if (!path || notes.has(embed)) continue;
    const label = alt?.trim() || basename(path);
    if (images >= MAX_IMAGES) {
      notes.set(embed, `_(image "${label}" not attached: more than ${MAX_IMAGES} in one reply)_`);
      continue;
    }
    const checked = checkImage(path);
    if ('problem' in checked) {
      notes.set(embed, `_(image "${label}" not attached: ${checked.problem})_`);
      continue;
    }
    if (sent.has(checked.path)) {
      notes.set(embed, `_(image attached above: ${label})_`);
      continue;
    }
    if (!(await mayUpload())) break;
    const error = await upload(client, thread, checked.path, label, label);
    if (error) {
      notes.set(embed, `_(image "${label}" not attached: ${error.message})_`);
      continue;
    }
    images++;
    sent.add(checked.path);
    notes.set(embed, `_(image attached above: ${label})_`);
  }

  const attached = new Map<string, string>();
  let files = 0;
  for (const [link, rawLabel, bracketed, plain] of links) {
    const path = bracketed ?? plain;
    if (!path || attached.has(link)) continue;
    const name = rawLabel?.replaceAll('`', '').trim();
    const label = !name || name === path ? basename(path) : rawLabel!.trim();
    const checked = checkShareable(path, MAX_FILE_BYTES, FILE_ROOTS);
    if ('problem' in checked) continue;
    if (!sent.has(checked.path)) {
      if (files >= MAX_FILES) continue;
      if (!(await mayUpload())) break;
      if (await upload(client, thread, checked.path, label.replaceAll('`', ''))) continue;
      files++;
      sent.add(checked.path);
    }
    attached.set(link, `${label} _(attached above)_`);
  }

  return text
    .replace(LOCAL_IMAGE, (embed) => notes.get(embed) ?? embed)
    .replace(LOCAL_FILE_LINK, (link) => attached.get(link) ?? link);
};
