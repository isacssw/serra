// The menubar item (APP-11): the brand status icon, the bot's state and job counts, Open Serra and Restart bot.
// From the second profile (SB-11) it lists every profile instead: a native row each (avatar with its dot, name and
// phrase), a submenu to open, start a task, restart or stop it, and the icon carries the worst state across them.
// What it shows comes from `tray.logic.ts`; this file only draws it with Electron.
import { join } from 'node:path';
import { BrowserWindow, Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import {
  multiTrayView, trayController, type MultiTrayView, type RowDot, type TrayIcon, type TrayProfile, type TrayStatusFeed, type TrayView,
} from './tray.logic.ts';

/** Menubar icons are 18 points; the 2× copy keeps them sharp on Retina screens. */
const SIZE = 18;
const ICONS: readonly TrayIcon[] = ['up', 'needs-you', 'down'];

const loadIcon = (iconsDir: string, icon: TrayIcon, size: number): NativeImage => {
  const path = join(iconsDir, `serra-status-${icon}.png`);
  const source = nativeImage.createFromPath(path);
  if (source.isEmpty()) throw new Error(`Missing menubar icon ${path}`);
  const image = nativeImage.createEmpty();
  for (const scaleFactor of [1, 2]) {
    image.addRepresentation({ scaleFactor, buffer: source.resize({ width: size * scaleFactor, height: size * scaleFactor, quality: 'best' }).toPNG() });
  }
  return image;
};

/**
 * The dots' colours: the window's up, warn, down and faint hues (styles.css), in tones that read on both the light and
 * the dark menu. A menubar menu follows macOS's appearance, not the app's theme, so one set serves both. The dot is
 * also cut out of the avatar, so it never blends into it.
 */
const DOT_COLORS: Record<Exclude<RowDot, 'none'>, string> = { up: '#22a06b', warn: '#d4880f', down: '#e5484d', faint: '#8b8b95' };

interface AvatarKey { letters: string; color: string; dot: RowDot }
const avatarKey = ({ letters, color, dot }: AvatarKey): string => `${letters}|${color}|${dot}`;

/**
 * Draws 16-point avatars (2×) with the dot cut into the corner, in a hidden window that is closed straight after, so
 * the menubar keeps no second renderer around. Every dot of a look is drawn at once: a status change needs no redraw.
 */
const drawAvatars = async (looks: readonly { letters: string; color: string }[]): Promise<Map<string, NativeImage>> => {
  const jobs = looks.flatMap((look) => (['up', 'warn', 'down', 'faint', 'none'] as const).map((dot) => ({ ...look, dot })));
  const painter = new BrowserWindow({
    show: false, width: 64, height: 64, paintWhenInitiallyHidden: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, offscreen: false },
  });
  try {
    await painter.loadURL('data:text/html;charset=utf-8,<!doctype html><canvas></canvas>');
    const script = `(() => {
      const jobs = ${JSON.stringify(jobs)}, dots = ${JSON.stringify(DOT_COLORS)};
      const px = 32, c = document.querySelector('canvas'); c.width = px; c.height = px;
      const g = c.getContext('2d');
      return jobs.map((job) => {
        g.clearRect(0, 0, px, px);
        g.globalCompositeOperation = 'source-over';
        g.fillStyle = job.color; g.beginPath(); g.roundRect(1, 1, 30, 30, 8); g.fill();
        g.fillStyle = '#ffffff';
        g.font = '600 ' + (job.letters.length > 1 ? 14 : 16) + 'px -apple-system, system-ui, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(job.letters, 16, 17);
        if (job.dot !== 'none') {
          g.globalCompositeOperation = 'destination-out';
          g.beginPath(); g.arc(25, 25, 9, 0, Math.PI * 2); g.fill();
          g.globalCompositeOperation = 'source-over';
          g.fillStyle = dots[job.dot]; g.beginPath(); g.arc(25, 25, 6, 0, Math.PI * 2); g.fill();
        }
        return c.toDataURL('image/png');
      });
    })()`;
    const urls: unknown = await painter.webContents.executeJavaScript(script);
    const out = new Map<string, NativeImage>();
    if (!Array.isArray(urls)) return out;
    jobs.forEach((job, index) => {
      const url: unknown = urls[index];
      if (typeof url !== 'string') return;
      const image = nativeImage.createFromDataURL(url);
      const sized = nativeImage.createEmpty();
      sized.addRepresentation({ scaleFactor: 2, buffer: image.toPNG() });
      out.set(avatarKey(job), sized);
    });
    return out;
  } finally {
    painter.destroy();
  }
};

/** What the menubar does for one profile. Each may fail; the failure is logged, the menu stays. */
interface TrayProfileActions {
  open(dir: string): void;
  newTask(dir: string): void;
  restart(dir: string): Promise<void>;
  stop(dir: string): Promise<void>;
}

export interface SerraTrayOptions {
  /** `assets/brand`, where the status icons are. */
  iconsDir: string;
  status: TrayStatusFeed;
  profileSelected(): boolean;
  restart(): Promise<void>;
  /** Shows the main window, creating it when it was closed. */
  openWindow(): void;
  /** Every profile in ⌘ order with its live status. Two or more (and not pinned): the menu lists them. */
  profiles(): readonly TrayProfile[];
  actions: TrayProfileActions;
  log?: (message: string) => void;
}

export interface SerraTray {
  /** Draws again after something outside the status feed changed (the profile, another profile's status). */
  refresh(): void;
  destroy(): void;
}

export const createTray = ({ iconsDir, status, profileSelected, restart, openWindow, profiles, actions, log = console.error }: SerraTrayOptions): SerraTray => {
  const icons = Object.fromEntries(ICONS.map((icon) => [icon, loadIcon(iconsDir, icon, SIZE)])) as Record<TrayIcon, NativeImage>;
  const small = Object.fromEntries(ICONS.map((icon) => [icon, loadIcon(iconsDir, icon, 14)])) as Record<TrayIcon, NativeImage>;
  const tray = new Tray(icons.down);
  tray.setIgnoreDoubleClickEvents(true);
  let destroyed = false;

  let controller: ReturnType<typeof trayController> | null = null;
  const renderOne = (view: TrayView): void => {
    tray.setImage(icons[view.icon]);
    tray.setToolTip(view.tooltip);
    const template: MenuItemConstructorOptions[] = [
      { label: view.headline, icon: small[view.icon], enabled: false },
      ...view.details.map((detail): MenuItemConstructorOptions => ({ label: detail.label, enabled: false })),
      { type: 'separator' },
      { label: 'Open Serra', click: () => openWindow() },
      { label: view.restart.label, enabled: view.restart.enabled, click: () => { void controller?.restart(); } },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(template));
  };

  // Two or more profiles.
  const avatars = new Map<string, NativeImage>();
  const drawing = new Set<string>();
  const busy = new Set<string>();
  /** macOS 14.4 shows a second line (sublabel); older versions show one line with the phrase in it. */
  const twoLines = process.platform === 'darwin' && (() => {
    const [major = 0, minor = 0] = process.getSystemVersion().split('.').map(Number);
    return major > 14 || (major === 14 && minor >= 4);
  })();
  const act = (dir: string, work: (dir: string) => Promise<void>): void => {
    if (busy.has(dir)) return;
    busy.add(dir);
    draw();
    void work(dir).catch((error: unknown) => log(`[serra] menubar action failed: ${String(error)}`)).finally(() => { busy.delete(dir); draw(); });
  };
  const ensureAvatars = (view: MultiTrayView): void => {
    const missing = view.rows.filter((row) => !avatars.has(avatarKey(row.avatar)) && !drawing.has(avatarKey(row.avatar)));
    if (!missing.length) return;
    const looks = [...new Map(missing.map((row) => [`${row.avatar.letters}|${row.avatar.color}`, { letters: row.avatar.letters, color: row.avatar.color }])).values()];
    const keys = looks.flatMap((look) => (['up', 'warn', 'down', 'faint', 'none'] as const).map((dot) => avatarKey({ ...look, dot })));
    for (const key of keys) drawing.add(key);
    void drawAvatars(looks).then((drawn) => {
      for (const [key, image] of drawn) avatars.set(key, image);
    }, (error: unknown) => log(`[serra] could not draw menubar avatars: ${String(error)}`)).finally(() => {
      for (const key of keys) drawing.delete(key);
      if (!destroyed) draw();
    });
  };
  const renderMany = (view: MultiTrayView): void => {
    tray.setImage(icons[view.icon]);
    tray.setToolTip(view.tooltip);
    ensureAvatars(view);
    const template: MenuItemConstructorOptions[] = view.rows.map((row): MenuItemConstructorOptions => {
      const icon = avatars.get(avatarKey(row.avatar));
      const submenu: MenuItemConstructorOptions[] = [
        { label: row.open, ...(row.shortcut ? { accelerator: `CommandOrControl+${row.shortcut.slice(1)}`, registerAccelerator: false } : {}), click: () => actions.open(row.dir) },
        ...(row.newTask ? [{ label: row.newTask, click: () => actions.newTask(row.dir) }] : []),
      ];
      const service: MenuItemConstructorOptions[] = [
        ...(row.restart ? [{ label: row.restart.label, enabled: row.restart.enabled, click: () => act(row.dir, actions.restart) }] : []),
        ...(row.stop ? [{ label: row.stop.label, enabled: row.stop.enabled, click: () => act(row.dir, actions.stop) }] : []),
      ];
      if (service.length) submenu.push({ type: 'separator' }, ...service);
      return {
        label: twoLines ? row.label : row.oneLine,
        ...(twoLines ? { sublabel: row.sublabel } : {}),
        ...(icon ? { icon } : {}),
        submenu,
      };
    });
    template.push({ type: 'separator' }, { label: 'Open Serra', click: () => openWindow() });
    tray.setContextMenu(Menu.buildFromTemplate(template));
  };

  const many = (): readonly TrayProfile[] | null => {
    try {
      const list = profiles();
      return list.length > 1 ? list : null;
    } catch (error) { log(`[serra] could not list profiles for the menubar: ${String(error)}`); return null; }
  };
  const render = (view: TrayView): void => {
    const list = many();
    if (list) renderMany(multiTrayView(list, busy));
    else renderOne(view);
  };
  const draw = (): void => { if (!destroyed) controller?.refresh(); };
  controller = trayController({ status, profileSelected, restart, render, log });
  return {
    refresh: draw,
    destroy: () => {
      destroyed = true;
      controller?.stop();
      tray.destroy();
    },
  };
};
