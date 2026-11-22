/**
 * App updates from GitHub Releases: which release is newer, which file to download for this Mac, and whether the
 * download matches the release's `SHA256SUMS`. No Electron here, so `node --test` covers it; the app's updater
 * (`app/main/app-updater.ts`) passes Electron's `net.fetch` in as `fetch`.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

/** The repository the packaged app updates from. Releases are cut by `.github/workflows/release-publish.yml`. */
export const UPDATE_REPOSITORY = 'isacssw/serra';
/**
 * The releases list. `/releases/latest` is not enough: alphas are published as prereleases with `--latest=false`,
 * so while every release is an alpha it returns 404. `SERRA_UPDATES_FEED` points at another list (QA's fake feed).
 */
export const releasesUrl = (env: NodeJS.ProcessEnv = process.env): string =>
  env.SERRA_UPDATES_FEED || `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=30`;

// ---------------------------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------------------------

interface Version { core: [number, number, number]; pre: string[] }

/** `v0.1.0-alpha.2` or `0.1.0` → its parts. Null for anything that isn't `major.minor.patch[-pre][+build]`. */
export const parseVersion = (value: string): Version | null => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] };
};

/** A prerelease version, like `0.1.0-alpha.2`. */
export const isPrerelease = (value: string): boolean => (parseVersion(value)?.pre.length ?? 0) > 0;

const comparePart = (a: string, b: string): number => {
  const numeric = /^\d+$/;
  if (numeric.test(a) && numeric.test(b)) return Math.sign(Number(a) - Number(b));
  if (numeric.test(a)) return -1;
  if (numeric.test(b)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Semantic Versioning order: negative when `a` is older than `b`. A prerelease is older than its release
 * (`0.1.0-alpha.9` < `0.1.0`), and prerelease parts compare numerically when both are numbers (`alpha.10` > `alpha.9`).
 * Throws for a value that isn't a version.
 */
export const compareVersions = (a: string, b: string): number => {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) throw new Error(`Not a version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return Math.sign(x.core[i]! - y.core[i]!);
  if (!x.pre.length || !y.pre.length) return x.pre.length ? -1 : y.pre.length ? 1 : 0;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const order = comparePart(x.pre[i]!, y.pre[i]!);
    if (order) return order;
  }
  return Math.sign(x.pre.length - y.pre.length);
};

/** Whether prereleases are offered: the owner's choice, else on while the installed version is itself a prerelease. */
export const includePrereleases = (choice: boolean | null, current: string): boolean => choice ?? isPrerelease(current);

// ---------------------------------------------------------------------------------------------------------------
// Picking a release
// ---------------------------------------------------------------------------------------------------------------

/** The fields of a GitHub release this module reads. */
export interface GithubRelease {
  tag_name: string;
  name?: string | null;
  body?: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at?: string | null;
  html_url: string;
  assets: { name: string; browser_download_url: string; size: number }[];
}

export interface AppRelease {
  version: string;
  prerelease: boolean;
  /** The release notes (the changelog section), as Markdown. */
  notes: string;
  publishedAt: string | null;
  /** The release page on GitHub. */
  url: string;
  dmg: { name: string; url: string; size: number };
  sums: { url: string };
}

export type UpdateCheck =
  | { kind: 'available'; release: AppRelease }
  | { kind: 'up-to-date' }
  /**
   * A newer release can't be installed: no build for this Mac (only arm64 is published today), or no `SHA256SUMS` to
   * check it against.
   */
  | { kind: 'no-build'; version: string; url: string; reason: 'arch' | 'checksum' };

/**
 * The `.dmg` for this Mac's architecture. electron-builder names them `Serra-<version>-arm64.dmg`, and the x64 one
 * without a suffix; a `-universal.dmg` fits both.
 */
export const dmgFor = (assets: GithubRelease['assets'], arch: string): GithubRelease['assets'][number] | null => {
  const dmgs = assets.filter((asset) => asset.name.endsWith('.dmg'));
  const suffix = (name: string): string => /-(arm64|x64|universal)\.dmg$/.exec(name)?.[1] ?? 'x64';
  return dmgs.find((asset) => suffix(asset.name) === arch) ?? dmgs.find((asset) => suffix(asset.name) === 'universal') ?? null;
};

/**
 * The newest release above `current` this Mac can install: not a draft, a prerelease only when they're included, with a
 * `.dmg` for `arch` and a `SHA256SUMS` to check it against. When the newest one has no build for this Mac, says so.
 */
export const pickUpdate = (releases: GithubRelease[], { current, arch, prereleases }: { current: string; arch: string; prereleases: boolean }): UpdateCheck => {
  const newer = releases
    .filter((release) => !release.draft && (prereleases || !release.prerelease) && parseVersion(release.tag_name))
    .filter((release) => compareVersions(release.tag_name, current) > 0)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  for (const release of newer) {
    const dmg = dmgFor(release.assets, arch);
    const sums = release.assets.find((asset) => asset.name === 'SHA256SUMS');
    if (!dmg || !sums) continue;
    return {
      kind: 'available',
      release: {
        version: release.tag_name.replace(/^v/, ''),
        prerelease: release.prerelease,
        notes: (release.body ?? '').trim(),
        publishedAt: release.published_at ?? null,
        url: release.html_url,
        dmg: { name: dmg.name, url: dmg.browser_download_url, size: dmg.size },
        sums: { url: sums.browser_download_url },
      },
    };
  }
  const first = newer[0];
  if (!first) return { kind: 'up-to-date' };
  return { kind: 'no-build', version: first.tag_name.replace(/^v/, ''), url: first.html_url, reason: dmgFor(first.assets, arch) ? 'checksum' : 'arch' };
};

export type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

const GITHUB_HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'Serra-updater', 'x-github-api-version': '2022-11-28' };

/** Reads the releases list. A refusal (rate limit, outage) throws a short message for the screen. */
export const fetchReleases = async (fetch: Fetch, url = releasesUrl()): Promise<GithubRelease[]> => {
  let response: Response;
  try { response = await fetch(url, { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(20_000) }); }
  catch { throw new Error("Couldn't reach GitHub. Check your connection and try again."); }
  if (response.status === 403 || response.status === 429) throw new Error('GitHub is limiting requests right now. Try again in a few minutes.');
  if (!response.ok) throw new Error(`GitHub answered ${response.status}. Try again later.`);
  const body = await response.json() as unknown;
  if (!Array.isArray(body)) throw new Error('GitHub sent an unexpected answer.');
  return body as GithubRelease[];
};

// ---------------------------------------------------------------------------------------------------------------
// Download and checksum
// ---------------------------------------------------------------------------------------------------------------

/** `SHA256SUMS` (`shasum -a 256` output: `<hex>  <name>`) → the expected hash of each file, lowercase. */
export const parseSums = (text: string): Map<string, string> => {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match) sums.set(match[2]!, match[1]!.toLowerCase());
  }
  return sums;
};

export const sha256File = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
};

/**
 * Checks the downloaded `path` against its line (`name`) in `sumsText`. Throws when the line is missing or the hash
 * differs. This catches a broken or swapped download, but `SHA256SUMS` comes from the same release, so it can't prove
 * who published it: until the app is signed, publishing access to the repository is the trust boundary.
 */
export const verifyChecksum = async (path: string, name: string, sumsText: string): Promise<void> => {
  const expected = parseSums(sumsText).get(name);
  if (!expected) throw new Error(`The release's SHA256SUMS has no line for ${name}.`);
  const actual = await sha256File(path);
  if (actual !== expected) throw new Error("The download doesn't match the checksum published with the release.");
};

export interface DownloadProgress { received: number; total: number | null }

/**
 * Downloads `url` to `to`, reporting progress. The file is written by this process, not a browser, so macOS adds
 * no quarantine flag to it. Removes the partial file on failure or abort.
 */
export const download = async (fetch: Fetch, url: string, to: string, { signal, progress }: {
  signal?: AbortSignal; progress?: (update: DownloadProgress) => void;
} = {}): Promise<void> => {
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'Serra-updater' }, ...(signal ? { signal } : {}) });
    if (!response.ok || !response.body) throw new Error(`The download failed: GitHub answered ${response.status}.`);
    const total = Number(response.headers.get('content-length')) || null;
    let received = 0;
    let last = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        const now = Date.now();
        if (now - last > 200) { last = now; progress?.({ received, total }); }
        done(null, chunk);
      },
    });
    // Aborting `signal` aborts the fetch, which errors the body stream and so the pipeline.
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), counter, createWriteStream(to));
    progress?.({ received, total });
  } catch (error) {
    if (existsSync(to)) rmSync(to, { force: true });
    throw error;
  }
};

/** Downloads a small text file, like `SHA256SUMS`. */
export const downloadText = async (fetch: Fetch, url: string): Promise<string> => {
  const response = await fetch(url, { headers: { 'user-agent': 'Serra-updater' }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Couldn't download ${url.split('/').pop()}: GitHub answered ${response.status}.`);
  return response.text();
};
