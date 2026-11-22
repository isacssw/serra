// The app menu: macOS's standard menus, plus Set Up Serra… to reopen setup from anywhere (SERRA-51). Types only from
// Electron, so tests can read the template; index.ts builds it with `Menu`.
import type { MenuItemConstructorOptions } from 'electron';

/** The menu's template. Pure apart from the click, so tests can read it without Electron. */
export const menuTemplate = (openSetup: () => void, platform: string = process.platform): MenuItemConstructorOptions[] => {
  const setup: MenuItemConstructorOptions = { label: 'Set Up Serra…', click: openSetup };
  return [
    ...(platform === 'darwin'
      ? [{
        role: 'appMenu' as const,
        submenu: [
          { role: 'about' as const }, { type: 'separator' as const }, setup, { type: 'separator' as const },
          { role: 'services' as const }, { type: 'separator' as const },
          { role: 'hide' as const }, { role: 'hideOthers' as const }, { role: 'unhide' as const }, { type: 'separator' as const },
          { role: 'quit' as const },
        ],
      }]
      : [{ label: 'File', submenu: [setup, { type: 'separator' as const }, { role: 'quit' as const }] }]),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
};
