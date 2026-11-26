// Images between Serra and an agent. In: a Slack attachment Serra downloaded is listed in the message with its type
// and local path (src/slack/attachments.ts); an agent that takes images over ACP also gets the image itself. Only files
// in Serra's own attachments folder are ever read, so a line someone typed can't make Serra send another file. Out: an
// image an agent sends as content is saved where replies may share images from, and embedded in its reply, so the
// chat uploads it as it does an image file the agent names.
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

/** Image types an agent takes, by MIME type. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Larger images stay a path: providers refuse images past about 5 MB. */
const MAX_INLINE_BYTES = 5 * 1024 * 1024;
/** How `receiveAttachments` lists a downloaded file: `- name ("type", N bytes): local path "…"`. */
const ATTACHMENT_LINE = /\("(image\/[a-z0-9.+-]+)", \d+ bytes\): local path ("(?:[^"\\]|\\.)*")/g;

export interface AttachedImage { path: string; mimeType: string }

/** The image attachments a message lists, that are in `root` (Serra's attachments folder). */
export const attachedImages = (text: string, root: string): AttachedImage[] => {
  let realRoot: string;
  try { realRoot = realpathSync(root); } catch { return []; }
  const found: AttachedImage[] = [];
  for (const [, mimeType, quoted] of text.matchAll(ATTACHMENT_LINE)) {
    if (!mimeType || !quoted || !IMAGE_TYPES.has(mimeType)) continue;
    let path: string;
    try {
      const named: unknown = JSON.parse(quoted);
      if (typeof named !== 'string') continue;
      path = realpathSync(named);
    } catch { continue; }
    if (path.startsWith(`${realRoot}${sep}`) && !found.some((image) => image.path === path)) found.push({ path, mimeType });
  }
  return found;
};

/** An attached image as ACP image content, or null when it's too large to send inline. */
export const imageContent = (image: AttachedImage): { type: 'image'; data: string; mimeType: string } | null => {
  try {
    if (statSync(image.path).size > MAX_INLINE_BYTES) return null;
    return { type: 'image', data: readFileSync(image.path).toString('base64'), mimeType: image.mimeType };
  } catch { return null; }
};

const EXTENSIONS: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

/** Saves an image an agent sent as content, and gives the Markdown that embeds it in its reply. Null for a type Serra doesn't share. */
export const saveAgentImage = (data: string, mimeType: string, name: string, dir = join(tmpdir(), 'serra-agent-images')): string | null => {
  const extension = EXTENSIONS[mimeType];
  if (!extension) return null;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${name.replace(/[^\w.-]+/g, '-')}${extension}`);
  writeFileSync(path, Buffer.from(data, 'base64'), { mode: 0o600 });
  return `![image](${path})`;
};
