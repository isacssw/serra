import { launch, shot, text, go } from './lib.mjs';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const P = '/tmp/serra-qa/profile', K = P + '/knowledge';
const { app, page, logs } = await launch({ profile: P, userData: '/tmp/serra-qa/ud' });
await app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (u) => { globalThis.__opened.push(u); }; shell.openPath = async (p) => { globalThis.__opened.push('path:' + p); return ''; }; });
await page.waitForTimeout(1000);
await go(page, '/jobs/needs-you'); await page.waitForTimeout(1500);
// C2 channel filter
await page.getByRole('combobox', { name: 'Channel' }).click(); await page.getByRole('option').last().click(); await page.waitForTimeout(800);
console.log('FILTERED:', (await text(page)).replace(/\n+/g, ' | ').slice(0, 400));
await shot(page, 'C2-jobs-channel-filter');
await page.getByRole('combobox', { name: 'Channel' }).click(); await page.getByRole('option', { name: 'All channels' }).click(); await page.waitForTimeout(800);
// C3 links
await page.getByRole('button', { name: 'T3' }).first().click(); await page.getByRole('button', { name: 'PR' }).nth(2).click().catch((e) => console.log('PR click', e.message.split('\n')[0]));
await page.waitForTimeout(300);
console.log('OPENED:', await app.evaluate(() => globalThis.__opened));
// C4 cleanup dry run
await page.getByRole('button', { name: 'Clean up worktrees' }).click(); await page.waitForTimeout(4000);
console.log('CLEANUP:', await page.evaluate(() => document.querySelector('dialog[open]')?.innerText));
await shot(page, 'C4-cleanup-dry-run');
await page.keyboard.press('Escape');
// D proposals
await go(page, '/knowledge/proposals'); await page.waitForTimeout(1200);
await page.getByRole('button', { name: /Reviews/ }).click(); await page.waitForTimeout(800);
console.log('REVIEWS DETAIL:', (await text(page)).split('Reviews').slice(-1)[0].replace(/\n+/g, ' | ').slice(0, 600));
await shot(page, 'D1-proposal-diff-existing');
// promote oncall into ops, then undo
await page.getByRole('button', { name: /Oncall/ }).click(); await page.waitForTimeout(600);
await page.getByRole('button', { name: 'Promote' }).click(); await page.waitForTimeout(1200);
console.log('AFTER PROMOTE toast:', await page.evaluate(() => document.querySelector('[role=status], [data-toast]')?.innerText ?? document.body.innerText.match(/Promoted.{0,80}/)?.[0]));
console.log('files:', existsSync(K + '/ops/2026-11-19-oncall.md') || readdirSync(K + '/ops'), readFileSync(K + '/index.md', 'utf8').split('\n').slice(-3));
await shot(page, 'D2-proposal-promoted-toast');
await page.getByRole('button', { name: 'Undo' }).click(); await page.waitForTimeout(1200);
console.log('AFTER UNDO:', readdirSync(K + '/ops'), existsSync(K + '/proposals/2026-11-19-oncall.md'), readFileSync(K + '/index.md', 'utf8').split('\n').slice(-3));
// discard
await page.getByRole('button', { name: /Discard me/ }).click(); await page.waitForTimeout(600);
await page.getByRole('button', { name: 'Discard', exact: true }).click(); await page.waitForTimeout(1200);
console.log('AFTER DISCARD:', existsSync(K + '/proposals/2026-11-19-discard-me.md'), (await text(page)).slice(0, 200).replace(/\n+/g, ' | '));
// merge reviews into owner/role.md
await page.getByRole('button', { name: /Reviews/ }).click(); await page.waitForTimeout(600);
await page.getByRole('button', { name: /Merge into/ }).click(); await page.waitForTimeout(600);
console.log('MERGE DIALOG:', await page.evaluate(() => document.querySelector('dialog[open]')?.innerText));
await shot(page, 'D3-merge-dialog');
await app.close();
console.log(logs.filter((l) => /pageerror|console.error/.test(l)).join('\n'));
