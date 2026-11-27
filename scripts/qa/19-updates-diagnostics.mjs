import { launch, shot, text, go } from './lib.mjs';
import { readFileSync, existsSync } from 'node:fs';
const P = '/tmp/serra-qa/profile';
const { app, page, logs } = await launch({ profile: P, userData: '/tmp/serra-qa/ud' });
await page.waitForTimeout(1000);
await go(page, '/settings/updates'); await page.waitForTimeout(1500);
await page.getByRole('button', { name: 'Check for commits' }).click(); await page.waitForTimeout(5000);
console.log('UPDATES:', (await text(page)).slice(0, 700).replace(/\n+/g, ' | '));
await page.getByRole('button', { name: 'Prepare' }).click(); await page.waitForTimeout(800);
const dlg = await page.evaluate(() => document.querySelector('dialog[open]')?.innerText); if (dlg) { console.log('PREPARE DIALOG', dlg); await page.locator('dialog[open]').getByRole('button', { name: /Prepare/ }).click(); }
for (let i = 0; i < 90; i++) { await page.waitForTimeout(1000); if (!(await text(page)).includes('Preparing')) break; }
console.log('AFTER PREPARE:', (await text(page)).slice(0, 900).replace(/\n+/g, ' | '));
await shot(page, 'J1-updates-prepared');
await page.getByRole('button', { name: 'Activate' }).click(); await page.waitForTimeout(800);
console.log('ACTIVATE DIALOG:', await page.evaluate(() => document.querySelector('dialog[open]')?.innerText));
await shot(page, 'J2-activate-confirm');
await page.locator('dialog[open]').getByRole('button', { name: /Activate/ }).click();
for (let i = 0; i < 120; i++) { await page.waitForTimeout(1000); if (!/Activating/.test(await text(page))) break; }
console.log('AFTER ACTIVATE:', (await text(page)).slice(0, 1500).replace(/\n+/g, ' | '));
await shot(page, 'J3-activate-refused');
console.log('rollback btn disabled:', await page.getByRole('button', { name: 'Roll back' }).isDisabled());
console.log('bridge rollback:', await page.evaluate(() => window.serra.updates.rollback().then((r) => JSON.stringify(r), (e) => 'ERR ' + e.message)));
console.log('active.json?', existsSync(P + '/active.json'));
// diagnostics
await go(page, '/settings/diagnostics'); await page.waitForTimeout(6000);
await app.evaluate(({ clipboard }) => clipboard.writeText(''));
await page.getByRole('button', { name: 'Copy report' }).click(); await page.waitForTimeout(500);
const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
console.log('COPIED REPORT:\n' + clip.slice(0, 1200));
await page.getByRole('combobox', { name: 'Lines' }).click().catch(() => {}); await page.getByRole('option', { name: '500 lines' }).click().catch(() => {}); await page.waitForTimeout(800);
console.log('log lines shown:', await page.evaluate(() => document.querySelector('[data-serra-main] pre')?.textContent.split('\n').length));
await shot(page, 'J4-diagnostics');
await app.close();
console.log(logs.filter((l) => /pageerror|console.error/.test(l)).join('\n').slice(0, 1500));
