// `--smoke` checks, run against the real window: no Node in the page, the bridge is there, and with no daemon the
// window gets `stopped` and a failing call rejects with its message instead of crashing anything.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeTheme, type BrowserWindow } from 'electron';
import type { Theme } from './bridge.ts';
import { codeRoot } from '../../src/config.ts';
import { createJournal } from '../../src/knowledge-journal.ts';
import { createProfile } from '../../src/setup.ts';
import { missingRuntimeFiles } from './runtime-files.ts';

interface PageReport {
  require: string;
  process: string;
  module: string;
  bridge: string[];
  status: unknown;
  pushed: unknown;
  rejected: string;
  fileLink: string;
  prefsTheme: unknown;
  savedScreen: unknown;
  renderer: RendererReport;
}

/** APP-10: the built renderer mounted, its header shows real state, and each sidebar link opens its own screen. */
interface RendererReport {
  title: string;
  /** SERRA-51: with no profile the window opens on setup's welcome, full-window, with no sidebar. */
  setup: { hash: string; heading: string | null; sidebar: boolean };
  /** Sidebar items that showed the shared "finish setup" state instead of their screen. */
  gated: string[];
  header: string | null;
  visited: { route: string; label: string; heading: string | null; hash: string }[];
  /**
   * APP-16: ⌘K on each screen opens the palette and Escape closes it; a search then Enter opens the screen found.
   * `shutByLateClose`: screens where a late `close` event from an earlier close shut the reopened palette.
   */
  palette: { opened: string[]; notOpened: string[]; shutByLateClose: string[]; options: number; ranTo: string | null };
}

// Runs in the page, through the same `window.serra` the renderer uses. Listens for the next status push first,
// then asks main to resend.
const pageScript = `(async () => {
  const pushed = new Promise((resolve) => { const off = window.serra.on.status((s) => { off(); resolve(s); }); });
  const rejected = (promise) => promise.then(() => 'resolved', (error) => error.message);
  return {
    require: typeof require, process: typeof process, module: typeof module,
    bridge: Object.keys(window.serra).sort(),
    status: await window.serra.bot.status(),
    pushed: await Promise.race([pushed, new Promise((r) => setTimeout(() => r('no push'), 3000))]),
    rejected: await rejected(window.serra.diagnostics.logTail(0)),
    fileLink: await rejected(window.serra.app.openExternal('file:///etc/hosts')),
    prefsTheme: (await window.serra.app.getPrefs()).theme,
    savedScreen: (await window.serra.app.setPrefs({ lastScreen: '/smoke' }), (await window.serra.app.getPrefs()).lastScreen),
    renderer: await (async () => {
      const wait = async (check) => { for (let i = 0; i < 60 && !check(); i++) await new Promise((r) => setTimeout(r, 50)); return check(); };
      const header = () => document.querySelector('[data-status-tone]')?.textContent ?? null;
      await wait(() => document.querySelector('[data-serra-setup] h1'));
      const setup = { hash: location.hash, heading: document.querySelector('[data-serra-setup] h1')?.textContent ?? null, sidebar: Boolean(document.querySelector('[data-serra-sidebar]')) };
      location.hash = '#/jobs/needs-you';
      await wait(() => header() === 'Serra · stopped');
      const visited = [];
      const gated = [];
      for (const link of document.querySelectorAll('[data-serra-sidebar] a[data-route]')) {
        const label = link.querySelector('span')?.textContent ?? '';
        link.click();
        // A screen shared by several items (Jobs) names the item it shows in data-screen-label; others use their h1.
        const heading = () => document.querySelector('[data-serra-main] [data-screen-label]')?.getAttribute('data-screen-label')
          ?? document.querySelector('[data-serra-main] h1')?.textContent ?? null;
        await wait(() => heading() === label);
        visited.push({ route: link.dataset.route, label, heading: heading(), hash: location.hash });
        if (document.querySelector('[data-serra-main] [data-setup-required]')) gated.push(link.dataset.route);
      }
      const palette = await (async () => {
        const dialog = () => document.querySelector('dialog[data-command-palette]');
        const field = () => dialog()?.querySelector('input') ?? null;
        const opened = [], notOpened = [], shutByLateClose = [];
        let options = 0;
        for (const link of document.querySelectorAll('[data-serra-sidebar] a[data-route]')) {
          link.click();
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
          if (await wait(() => dialog()?.open && field())) opened.push(link.dataset.route); else notOpened.push(link.dataset.route);
          // A dialog's close event comes a task after it shut, and Chromium can hold several back while frames are
          // slow (a cold CI runner), so one from the last Escape can reach the palette just reopened. It must stay open.
          if (dialog()?.open) {
            dialog().dispatchEvent(new Event('close'));
            await new Promise((r) => setTimeout(r, 50));
            if (!dialog()?.open) { shutByLateClose.push(link.dataset.route); continue; }
          }
          options = Math.max(options, document.querySelectorAll('dialog[data-command-palette] [role=option]').length);
          field()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await wait(() => !dialog()?.open);
        }
        window.dispatchEvent(new Event('serra:open-command-palette'));
        await wait(() => field());
        const input = field();
        if (input) {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'diagnostics');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await wait(() => dialog()?.querySelector('[role=option]')?.textContent?.startsWith('Diagnostics'));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }
        const heading = () => document.querySelector('[data-serra-main] h1')?.textContent ?? null;
        await wait(() => heading() === 'Diagnostics' && !dialog()?.open);
        return { opened, notOpened, shutByLateClose, options, ranTo: dialog()?.open ? null : heading() };
      })();
      return { title: document.title, setup, gated, header: header(), visited, palette };
    })(),
  };
})()`;

/** The window's smallest size (window-options.ts): every screen must still fit its width. */
const NARROW = { width: 640, height: 720 };
/** A split view's detail pane (a proposal's diff, the page editor) narrower than this is unusable. */
const MIN_DETAIL_WIDTH = 320;

/**
 * A throwaway profile with one indexed page and one proposal that changes it, so Proposals and Pages show their
 * list and detail side by side (or stacked) instead of an empty state.
 */
const layoutProfile = (): string => {
  const directory = join(mkdtempSync(join(tmpdir(), 'serra-smoke-profile-')), 'profile');
  createProfile(directory, {
    version: 1, bot: { id: 'smoke', name: 'Smoke' }, owner: { name: 'Smoke Owner', slackUserId: 'U0123456789', githubLogin: 'smoke' },
    project: { path: codeRoot, remote: 'origin', baseRef: 'origin/main', githubRepo: 'acme/project' }, allowedUsers: [], repositories: [],
  });
  const page = (description: string, extra: string[], text: string): string =>
    ['---', 'type: preference', `description: ${description}`, 'written: 2026-11-19', ...extra, 'sources:', '  - Owner interview, 2026-11-19', '---', '', text, ''].join('\n');
  const knowledge = join(directory, 'knowledge');
  mkdirSync(join(knowledge, 'owner'), { recursive: true });
  mkdirSync(join(knowledge, 'people'), { recursive: true });
  const team = ['verified: 2026-11-19', 'audience: team'];
  writeFileSync(join(knowledge, 'owner/role.md'), page("The owner's role", team, '# Smoke Owner\n\n- Tech lead for the payments API.\n- Works 09:00–17:00, Monday to Thursday.'));
  writeFileSync(join(knowledge, 'owner/working-style.md'), page('How the owner decides', team, '# How I work\n\n- Risky releases ship on Tuesday.\n- A bug fix starts with a failing test.'));
  writeFileSync(join(knowledge, 'owner/voice.md'), page('How the owner writes', team, '# Voice\n\n- Lead with the answer.\n- No exclamation marks.'));
  writeFileSync(join(knowledge, 'owner/notes.md'), page('Private notes', ['verified: 2026-11-19'], '# Notes\n\n- Owner-only.'));
  writeFileSync(join(knowledge, 'people/ana-silva.md'), page('Who Ana is', team, '# Ana Silva\n\n- Product manager. Prefers short written notes.'));
  writeFileSync(join(knowledge, 'index.md'), "# Knowledge index\n\n| When the request | Open | What it gives you |\n|---|---|---|\n"
    + "| who owns what | `owner/role.md` | The owner's role |\n| releases, tests | `owner/working-style.md` | How the owner decides |\n"
    + "| writing | `owner/voice.md` | How the owner writes |\n| private | `owner/notes.md` | Private notes |\n| mentions Ana | `people/ana-silva.md` | Who Ana is |\n");
  // A history for Overview: each page approved on its own day, one later edit that left an old rule beside its
  // replacement, and replies that named the pages they used.
  const backups = join(directory, 'backups', 'knowledge');
  const approved = [['owner/role.md', '2026-10-06'], ['owner/voice.md', '2026-10-06'], ['owner/notes.md', '2026-10-13'], ['owner/working-style.md', '2026-10-20'], ['people/ana-silva.md', '2026-11-03']] as const;
  const styleBefore = page('How the owner decides', team, '# How I work\n\n- Risky releases ship on Tuesday.\n- A bug fix starts with a failing test.');
  const styleAfter = page('How the owner decides', team, '# How I work\n\n- Risky releases ship on Tuesday.\n- A bug fix starts with a failing test.\n- Risky releases ship on Thursday now.');
  writeFileSync(join(knowledge, 'owner/working-style.md'), styleAfter);
  const record = (id: string, at: string, files: { path: string; before: string | null; after: string }[]): void => {
    mkdirSync(join(backups, id), { recursive: true });
    writeFileSync(join(backups, id, 'change.json'), JSON.stringify({ id, action: files[0]!.before === null ? 'promote' : 'edit', at: `${at}T10:00:00.000Z`, proposal: 'smoke', page: files[0]!.path, files }));
  };
  for (const [path, at] of approved) {
    record(`${at.replaceAll('-', '')}-${path.replace(/\W/g, '-')}`, at, [{ path, before: null, after: path === 'owner/working-style.md' ? styleBefore : readFileSync(join(knowledge, path), 'utf8') }]);
  }
  record('20261118-edit-working-style', '2026-11-18', [{ path: 'owner/working-style.md', before: styleBefore, after: styleAfter }]);
  mkdirSync(join(directory, 'logs'), { recursive: true });
  const uses: [string[], string, string][] = [
    [['owner/role.md', 'owner/working-style.md'], 'can we ship the refunds change on Thursday?', 'Yes: risky releases ship on Thursday now. Run the smoke suite first.'],
    [['owner/working-style.md'], 'do I need a test for this one-line fix?', 'Yes. A bug fix starts with a failing test.'],
    [[], 'thanks!', 'Any time.'],
    [['people/ana-silva.md', 'owner/role.md'], 'how should I send Ana the launch numbers?', 'A short written note: Ana prefers that to a call.'],
    [['owner/working-style.md'], 'is Thursday ok for the webhook release?', 'Thursday works: that is the current release day.'],
  ];
  writeFileSync(join(directory, 'logs', 'knowledge-usage.jsonl'), uses.map(([cited, request, reply], at) =>
    JSON.stringify({ at: new Date(Date.now() - (at + 1) * 86_400_000).toISOString(), runId: `smoke-${at}`, visibility: 'team', cited, offered: 4, request, reply })).join('\n') + '\n');
  // A weekly review, as the T3 run would have written it, with the rewrite it proposed, so Overview shows its digest.
  mkdirSync(join(knowledge, 'proposals', 'from-review', new Date().toISOString().slice(0, 10)), { recursive: true });
  writeFileSync(join(knowledge, 'proposals', 'from-review', new Date().toISOString().slice(0, 10), '.from.json'), JSON.stringify({ who: 'Weekly review', owner: false, via: 'review' }));
  writeFileSync(join(knowledge, 'proposals', 'from-review', new Date().toISOString().slice(0, 10), `${new Date().toISOString().slice(0, 10)}-owner-working-style.md`),
    page('How the owner decides', ['verified: no', 'audience: team', 'target: owner/working-style.md'], '# How I work\n\n- Risky releases ship on Thursday now.\n- A bug fix starts with a failing test.\n\n## Replaced\n\n- Until 2026-11-18: Risky releases ship on Tuesday.')
      .replace('  - Owner interview, 2026-11-19\n', `  - Owner interview, 2026-11-19\n  - Weekly review, ${new Date().toISOString().slice(0, 10)}\n`));
  mkdirSync(join(directory, 'knowledge-reviews'), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(join(directory, 'knowledge-reviews', `${today}.json`), JSON.stringify({
    id: today, at: new Date().toISOString(), from: new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10), to: today,
    summary: 'Your notes shaped 4 of 5 replies this week, most of all how you decide about releases. Two rules on that page disagree: settle the release day.',
    replies: 5, withKnowledge: 4, score: { before: 91, now: 84 }, facts: { before: 6, now: 7 },
    used: [{ page: 'owner/working-style.md', title: 'How the owner decides', uses: 3 }, { page: 'owner/role.md', title: "The owner's role", uses: 2 }],
    missing: [{ topic: 'who approves refunds over 500 EUR', count: 2 }],
    suggestions: [
      { id: 'replace:owner/working-style.md', kind: 'replace', page: 'owner/working-style.md', title: 'How the owner decides', why: 'Keeps Thursday, the newer rule, and moves Tuesday under Replaced.', proposal: `from-review/${today}/${today}-owner-working-style.md` },
    ],
    examples: [{ page: 'owner/working-style.md', title: 'How the owner decides', request: 'can we ship the refunds change on Thursday?', withPage: 'Yes, Thursday works: risky releases ship on Thursday now. Run the smoke suite first.', without: "I don't know which day risky releases ship. Check with the owner before shipping anything risky." }],
  }));
  writeFileSync(join(knowledge, 'proposals/2026-11-19-role.md'), page("The owner's role", ['verified: no', 'target: owner/role.md'], 'Owns the API and reviews every PR.'));
  // A correction that repeats a page the owner has, so Proposals shows where it belongs.
  writeFileSync(join(knowledge, 'proposals/2026-11-20-release-days.md'), page('When the owner ships', ['verified: no'], '- Risky releases ship on Thursday now.'));
  // A page changed outside Serra after the owner approved the rest, so Pages shows its notice.
  createJournal(knowledge).seed();
  writeFileSync(join(knowledge, 'owner/voice.md'), page('How the owner writes', team, '# Voice\n\n- Lead with the answer.\n- No exclamation marks.\n- Edited by hand.'));
  return directory;
};

interface LayoutReport { width: number; screens: { route: string; overflow: number; detailWidth: number | null }[] }

// At the narrowest window (macOS may keep it a little wider than asked), on every screen but Diagnostics (its checks
// reach T3, GitHub and Slack): nothing sticks out past the right edge, and a split view's detail pane stays usable.
const layoutScript = (profileDir: string): string => `(async () => {
  const wait = async (check) => { for (let i = 0; i < 80 && !check(); i++) await new Promise((r) => setTimeout(r, 50)); return check(); };
  await window.serra.app.setPrefs({ profileDir: ${JSON.stringify(profileDir)} });
  window.dispatchEvent(new Event('serra:setup-changed'));
  await wait(() => !document.querySelector('[data-setup-required]'));
  // The sidebar counts load a moment after the profile: wait for one so every capture shows them.
  await wait(() => document.querySelector('[data-serra-sidebar] a[data-route] span[aria-label]'));
  const screens = [];
  for (const link of document.querySelectorAll('[data-serra-sidebar] a[data-route]')) {
    if (link.dataset.route === 'diagnostics') continue;
    const label = link.querySelector('span')?.textContent ?? '';
    link.click();
    // The list is a <nav> beside (or above) the selected item's detail: a proposal's diff, the page editor.
    const detailPane = () => document.querySelector('[data-serra-main] nav[aria-label="' + label + '"]')?.nextElementSibling ?? null;
    const split = ['proposals', 'pages'].includes(link.dataset.route);
    await wait(() => (split ? detailPane() : document.querySelector('[data-serra-main] h1, [data-serra-main] [data-screen-label]')));
    await new Promise((r) => setTimeout(r, 300));
    const main = document.querySelector('[data-serra-main]');
    const detail = split ? detailPane() : null;
    // A control past the page's content edge (its title row spans it) spills into the padding or is cut off, which
    // scrollWidth doesn't show.
    const right = main.querySelector('header').getBoundingClientRect().right;
    const cut = Math.max(0, ...[...main.querySelectorAll('button, input, select, textarea, a')].map((el) => Math.round(el.getBoundingClientRect().right - right)));
    screens.push({ route: link.dataset.route, overflow: Math.max(main.scrollWidth - main.clientWidth, cut), detailWidth: detail ? Math.round(detail.getBoundingClientRect().width) : null });
  }
  await window.serra.app.setPrefs({ profileDir: null });
  window.dispatchEvent(new Event('serra:setup-changed'));
  return { width: window.innerWidth, screens };
})()`;

const runLayoutChecks = async (window: BrowserWindow): Promise<string[]> => {
  const directory = layoutProfile();
  const [width, height] = window.getSize();
  try {
    window.setSize(NARROW.width, NARROW.height);
    const report = await window.webContents.executeJavaScript(layoutScript(directory)) as LayoutReport;
    console.log(`[serra] smoke layout at ${report.width}px:`, JSON.stringify(report.screens));
    return [
      report.screens.length < 14 && 'the layout check did not visit every screen',
      ...report.screens.filter((screen) => screen.overflow > 1).map((screen) => `${screen.route} is ${screen.overflow}px too wide for a ${report.width}px window`),
      ...['proposals', 'pages'].filter((route) => {
        const screen = report.screens.find((item) => item.route === route);
        return !screen || screen.detailWidth === null || screen.detailWidth < MIN_DETAIL_WIDTH;
      }).map((route) => `${route}'s detail pane is narrower than ${MIN_DETAIL_WIDTH}px in a ${report.width}px window`),
    ].filter((failure): failure is string => typeof failure === 'string');
  } finally {
    if (width && height) window.setSize(width, height);
    rmSync(join(directory, '..'), { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Theme (APP-28)
// ---------------------------------------------------------------------------------------------------------------

/** What the window shows after a theme change, read in the page. */
interface ThemeReport { dataTheme: string | null; saved: unknown; checked: string | null; prefersDark: boolean; how: string }

const themeHelpers = `
  const wait = async (check) => { for (let i = 0; i < 80 && !check(); i++) await new Promise((r) => setTimeout(r, 50)); return check(); };
  const openAppearance = async () => {
    document.querySelector('[data-serra-sidebar] a[data-route="settings-appearance"]')?.click();
    return wait(() => document.querySelector('[data-serra-main] input[data-theme-option]'));
  };
  const report = async (theme, how) => {
    const shown = () => (theme === 'system' ? !('theme' in document.documentElement.dataset) : document.documentElement.dataset.theme === theme);
    await wait(shown);
    await openAppearance();
    // Saved once prefs say so; matchMedia then reflects nativeTheme, which main set from the save.
    await wait(async () => (await window.serra.app.getPrefs()).theme === theme);
    await new Promise((r) => setTimeout(r, 150));
    return {
      dataTheme: document.documentElement.dataset.theme ?? null,
      saved: (await window.serra.app.getPrefs()).theme,
      checked: document.querySelector('[data-serra-main] input[data-theme-option]:checked')?.value ?? null,
      prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
      how,
    };
  };`;

/** Picks a theme on Settings › Appearance. */
const themeControlScript = (theme: Theme): string => `(async () => {${themeHelpers}
  await openAppearance();
  document.querySelector('[data-serra-main] input[data-theme-option="${theme}"]')?.click();
  return report('${theme}', 'Settings › Appearance');
})()`;

/** Picks a theme with ⌘K › Switch theme…, then checks the Appearance control followed. */
const themePaletteScript = (theme: Theme, label: string): string => `(async () => {${themeHelpers}
  const dialog = () => document.querySelector('dialog[data-command-palette]');
  const field = () => dialog()?.querySelector('input') ?? null;
  const type = (text) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field(), text);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  };
  const enter = () => field()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  window.dispatchEvent(new Event('serra:open-command-palette'));
  await wait(() => field());
  type('switch theme');
  await wait(() => dialog()?.querySelector('[role=option]')?.textContent?.startsWith('Switch theme'));
  enter();
  await wait(() => [...(dialog()?.querySelectorAll('[role=option]') ?? [])].some((o) => o.textContent?.startsWith('${label}')));
  type('${label}');
  await wait(() => dialog()?.querySelector('[role=option]')?.textContent?.startsWith('${label}'));
  enter();
  await wait(() => !dialog()?.open);
  return report('${theme}', '⌘K › Switch theme…');
})()`;

/** The knowledge screens whose visible words the smoke run counts. */
const KNOWLEDGE_ROUTES = ['knowledge-overview', 'about-me', 'proposals', 'pages', 'brief'];

/** Words a person can see in the main pane: everything rendered, and what fits in the first screenful. */
const wordsScript = `(() => {
  const main = document.querySelector('[data-serra-main]');
  const count = (text) => (text.match(/[\\p{L}\\p{N}][\\p{L}\\p{N}'’.-]*/gu) ?? []).length;
  let total = 0; let firstScreen = 0;
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || !node.textContent.trim() || el.closest('[hidden], [aria-hidden="true"], dialog:not([open])')) continue;
    // Inside a closed <details>, only its summary shows.
    const shut = el.closest('details:not([open])');
    if (shut && !el.closest('summary')) continue;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (rects.length === 0) continue;
    const words = count(node.textContent);
    total += words;
    if (rects[0].top < window.innerHeight && rects[0].bottom > 0) firstScreen += words;
  }
  return { total, firstScreen };
})()`;

/** The least contrast text may have with what is behind it (WCAG AA for normal text). */
const MIN_CONTRAST = 4.5;

interface ContrastReport { route: string; checked: number; low: { text: string; ratio: number; color: string; background: string }[] }

/**
 * Opens one screen and measures every visible bit of text against the colours behind it (alpha layers composited,
 * colours resolved by drawing them on a canvas, so oklab and color-mix work). Disabled or faded text is skipped.
 */
const contrastScript = (route: string): string => `(async () => {
  const wait = async (check) => { for (let i = 0; i < 80 && !check(); i++) await new Promise((r) => setTimeout(r, 50)); return check(); };
  ${route.startsWith('#') ? `location.hash = '${route}'; await new Promise((r) => setTimeout(r, 100));` : `document.querySelector('[data-serra-sidebar] a[data-route="${route}"]')?.click();`}
  await wait(() => document.querySelector('[data-serra-main] h1, [data-serra-main] [data-screen-label]'));
  // With a profile, the sidebar counts load a moment later; the capture should show them.
  ${route.startsWith('#') ? '' : "window.dispatchEvent(new Event('serra:refresh-counts')); await wait(() => document.querySelector('[data-serra-sidebar] a[data-route=proposals] span[aria-label]'));"}
  await new Promise((r) => setTimeout(r, 400));
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1);
  const page = rgba(getComputedStyle(document.body).backgroundColor);
  const behind = (el) => {
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      const colour = rgba(getComputedStyle(node).backgroundColor);
      if (colour[3] > 0) layers.push(colour);
      if (colour[3] >= 0.999) break;
    }
    return layers.reduceRight((acc, layer) => over(layer, acc), page);
  };
  const luminance = (c) => { const [r, g, b] = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const faded = (el) => { for (let node = el; node; node = node.parentElement) if (Number(getComputedStyle(node).opacity) < 1) return true; return false; };
  const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const seen = new Set();
  const low = [];
  let checked = 0;
  for (const scope of document.querySelectorAll('[data-serra-sidebar], [data-serra-main]')) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const el = text.parentElement;
      if (!el || seen.has(el) || !text.textContent.trim()) continue;
      seen.add(el);
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (box.width <= 1 || box.height <= 1 || style.visibility === 'hidden') continue;
      if (el.closest(':disabled, [aria-disabled="true"]') || faded(el)) continue;
      const background = behind(el);
      const color = over(rgba(style.color), background);
      const value = ratio(color, background);
      checked += 1;
      if (value < ${MIN_CONTRAST}) low.push({ text: text.textContent.trim().slice(0, 40), ratio: Math.round(value * 100) / 100, color: hex(color), background: hex(background) });
    }
  }
  return { route: '${route}', checked, low };
})()`;

/** The screens the contrast check visits: every sidebar item but Diagnostics (its checks reach T3, GitHub, Slack). */
const routesScript = `[...document.querySelectorAll('[data-serra-sidebar] a[data-route]')].map((a) => a.dataset.route).filter((r) => r !== 'diagnostics')`;

/**
 * Switches the theme with the Appearance control and with ⌘K, and checks the page (`data-theme`, the control, the
 * saved pref, prefers-color-scheme) and main (`nativeTheme.themeSource`) follow. Then reads every screen in forced
 * light and forced dark for unreadable text. `SERRA_SMOKE_SHOTS=<folder>` also saves a screenshot of each.
 */
const runThemeChecks = async (window: BrowserWindow): Promise<string[]> => {
  const failures: string[] = [];
  const directory = layoutProfile();
  const shots = process.env.SERRA_SMOKE_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const run = async <T>(script: string): Promise<T> => await window.webContents.executeJavaScript(script) as T;
  const expect = (theme: Theme, report: ThemeReport): void => {
    const where = `${report.how} → ${theme}`;
    console.log(`[serra] smoke theme: ${where}: data-theme ${report.dataTheme ?? '(none)'}, saved ${String(report.saved)}, control ${report.checked}, nativeTheme ${nativeTheme.themeSource}, prefers dark ${report.prefersDark}`);
    if (report.dataTheme !== (theme === 'system' ? null : theme)) failures.push(`${where}: data-theme is ${report.dataTheme ?? '(none)'}`);
    if (report.saved !== theme) failures.push(`${where}: the pref saved is ${String(report.saved)}`);
    if (report.checked !== theme) failures.push(`${where}: the Appearance control shows ${report.checked}`);
    if (nativeTheme.themeSource !== theme) failures.push(`${where}: nativeTheme.themeSource is ${nativeTheme.themeSource}`);
    if (theme !== 'system' && report.prefersDark !== (theme === 'dark')) failures.push(`${where}: the page's prefers-color-scheme did not follow nativeTheme`);
  };
  /** Selects a profile (or none) the way setup does, so the shell's gate and setup's state follow. */
  const useProfile = (dir: string | null): Promise<unknown> => run(`(async () => {
    await window.serra.app.setPrefs({ profileDir: ${JSON.stringify(dir)} });
    window.dispatchEvent(new Event('serra:setup-changed'));
    await new Promise((r) => setTimeout(r, 300));
  })()`);
  /** Setup's screens (SERRA-51): with the layout profile (made, nothing else), then with none, plus a gated screen. */
  const withProfile = ['#/setup', '#/setup/you', '#/setup/slack', '#/setup/owner', '#/setup/service'];
  const withoutProfile = ['#/setup', '#/setup/you', '#/settings/bot'];
  try {
    await useProfile(directory);
    if (nativeTheme.themeSource !== 'system') failures.push(`nativeTheme.themeSource starts as ${nativeTheme.themeSource}, not the default system`);
    for (const theme of ['dark', 'light', 'system'] as const) expect(theme, await run(themeControlScript(theme)));
    for (const [theme, label] of [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']] as const) expect(theme, await run(themePaletteScript(theme, label)));

    const routes = await run<string[]>(routesScript);
    // Visible words on each knowledge screen, all of it and the first screenful, so copy cuts can be measured.
    const words: Record<string, { total: number; firstScreen: number }> = {};
    const countWords = async (name: string): Promise<void> => { words[name] = await run<{ total: number; firstScreen: number }>(wordsScript); };
    for (const theme of ['light', 'dark'] as const) {
      await run(themeControlScript(theme));
      const reports: ContrastReport[] = [];
      for (const route of routes) {
        const report = await run<ContrastReport>(contrastScript(route));
        reports.push(report);
        if (theme === 'light' && KNOWLEDGE_ROUTES.includes(route)) await countWords(route);
        if (shots) {
          writeFileSync(join(shots, `${theme}-${route}.png`), (await window.webContents.capturePage()).toPNG());
          // Pages with a page open, and its Retire dialog.
          if (route === 'pages') {
            await run(`(async () => { location.hash = '#/knowledge/pages?page=owner%2Fworking-style.md'; await new Promise((r) => setTimeout(r, 400)); (document.querySelector('[data-serra-main] nav[aria-label="Pages"]')?.nextElementSibling ?? document.querySelector('[data-serra-main] textarea'))?.scrollIntoView({ block: 'start' }); await new Promise((r) => setTimeout(r, 150)); })()`);
            if (theme === 'light') await countWords('pages-detail');
            writeFileSync(join(shots, `${theme}-pages-detail.png`), (await window.webContents.capturePage()).toPNG());
            await run(`(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Retire…')?.click(); await new Promise((r) => setTimeout(r, 300)); })()`);
            writeFileSync(join(shots, `${theme}-pages-retire.png`), (await window.webContents.capturePage()).toPNG());
            await run(`(async () => { [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent.trim() === 'Cancel')?.click(); await new Promise((r) => setTimeout(r, 200)); })()`);
          }
          // Overview is long: what the notes do, and its lower half, scrolled into view.
          if (route === 'knowledge-overview') {
            // Details open: what each page does, then the rest.
            await run(`(async () => { for (const d of document.querySelectorAll('[data-serra-main] details')) d.open = true; await new Promise((r) => setTimeout(r, 150)); document.querySelector('#value-title')?.scrollIntoView({ block: 'start' }); await new Promise((r) => setTimeout(r, 150)); })()`);
            writeFileSync(join(shots, `${theme}-${route}-value.png`), (await window.webContents.capturePage()).toPNG());
            await run(`(async () => { for (const el of document.querySelectorAll('*')) if (el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY.match(/auto|scroll/)) el.scrollTop = el.scrollHeight; await new Promise((r) => setTimeout(r, 150)); })()`);
            writeFileSync(join(shots, `${theme}-${route}-end.png`), (await window.webContents.capturePage()).toPNG());
          }
        }
        if (report.checked === 0) failures.push(`${theme}: no text found on ${route}`);
        for (const item of report.low) failures.push(`${theme}: "${item.text}" on ${route} reads at ${item.ratio}:1 (${item.color} on ${item.background})`);
      }
      const setupPass = async (hashes: string[], tag: string): Promise<void> => {
        for (const hash of hashes) {
          const report = await run<ContrastReport>(contrastScript(hash));
          const name = `${tag}${hash.slice(2).replaceAll('/', '-')}`;
          reports.push({ ...report, route: name });
          if (shots) writeFileSync(join(shots, `${theme}-${name}.png`), (await window.webContents.capturePage()).toPNG());
          if (report.checked === 0) failures.push(`${theme}: no text found on ${name}`);
          for (const item of report.low) failures.push(`${theme}: "${item.text}" on ${name} reads at ${item.ratio}:1 (${item.color} on ${item.background})`);
        }
      };
      await setupPass(withProfile, '');
      await useProfile(null);
      await setupPass(withoutProfile, 'none-');
      await useProfile(directory);
      await run(`location.hash = '#/jobs/needs-you'`);
      if (theme === 'light') {
        console.log('[serra] smoke words:', JSON.stringify(words));
        if (shots) writeFileSync(join(shots, 'words.json'), `${JSON.stringify(words, null, 2)}\n`);
      }
      console.log(`[serra] smoke contrast in ${theme}:`, JSON.stringify(reports.map(({ route, checked, low }) => ({ route, checked, low: low.length }))));
    }
  } finally {
    await run(themeControlScript('system')).catch(() => null);
    await useProfile(null).catch(() => null);
    rmSync(join(directory, '..'), { recursive: true, force: true });
  }
  return failures;
};

export const runSmokeChecks = async (window: BrowserWindow, resendStatus: () => void): Promise<boolean> => {
  const timer = setTimeout(resendStatus, 300);
  let report: PageReport;
  try { report = await window.webContents.executeJavaScript(pageScript) as PageReport; }
  finally { clearTimeout(timer); }
  console.log('[serra] smoke:', JSON.stringify(report, null, 2));
  // APP-17: the packaged app has to carry the files the code reads next to the bundle.
  const missing = missingRuntimeFiles(codeRoot);
  console.log(`[serra] smoke: codeRoot ${codeRoot}, runtime files ${missing.length ? `missing: ${missing.join(', ')}` : 'all present'}`);
  const stopped = (value: unknown): boolean => (value as { state?: string } | null)?.state === 'stopped';
  const failures = [
    report.require !== 'undefined' && 'the page can reach require',
    report.process !== 'undefined' && 'the page can reach process',
    report.module !== 'undefined' && 'the page can reach module',
    !stopped(report.status) && 'bot.status() is not stopped',
    !stopped(report.pushed) && 'the window was not sent a stopped status',
    !report.rejected.includes('log lines') && 'a failing call did not reject with its plain message',
    !report.fileLink.includes('http') && 'openExternal accepted a file: link',
    report.prefsTheme !== 'system' && 'prefs did not load their defaults',
    report.savedScreen !== '/smoke' && 'prefs did not save',
    report.renderer.title !== 'Serra' && 'the window is not titled Serra',
    report.renderer.header !== 'Serra · stopped' && 'the sidebar header does not show the stopped status',
    report.renderer.setup.hash !== '#/setup' && `with no profile the window opened on ${report.renderer.setup.hash}, not setup`,
    // "Welcome back" when profiles already exist on this Mac (they are only read).
    !/^Welcome (to Serra|back)$/.test(report.renderer.setup.heading ?? '') && 'setup did not open on its welcome',
    report.renderer.setup.sidebar && 'setup shows the sidebar',
    report.renderer.gated.length !== report.renderer.visited.length - 2 && `with no profile, ${report.renderer.gated.length} of ${report.renderer.visited.length} screens showed the setup state, not all but Updates and Appearance`,
    ...['updates', 'settings-appearance'].filter((route) => report.renderer.gated.includes(route)).map((route) => `${route} is gated but works without a profile`),
    report.renderer.visited.length < 15 && 'the sidebar does not list every screen',
    ...report.renderer.visited.filter((v) => v.heading !== v.label).map((v) => `sidebar item ${v.route} did not open its screen`),
    ...report.renderer.palette.notOpened.map((route) => `⌘K did not open the command palette on ${route}`),
    ...report.renderer.palette.shutByLateClose.map((route) => `a late close event shut the reopened command palette on ${route}`),
    report.renderer.palette.opened.length < 15 && '⌘K was not tried on every screen',
    report.renderer.palette.options < 18 && 'the command palette does not list every built-in action',
    report.renderer.palette.ranTo !== 'Diagnostics' && 'running a palette search did not open its screen',
    ...missing.map((path) => `runtime file ${path} is missing under ${codeRoot}`),
    ...await runLayoutChecks(window),
    ...await runThemeChecks(window),
  ].filter((failure): failure is string => typeof failure === 'string');
  for (const failure of failures) console.error(`[serra] smoke failed: ${failure}`);
  if (failures.length === 0) console.log('[serra] smoke passed');
  return failures.length === 0;
};
