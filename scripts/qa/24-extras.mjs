// Setup from Diagnostics and ⌘K, adding a repository, and Jobs rereading on a daemon event.
import { readFileSync, writeFileSync } from 'node:fs';
import { launch, shot, text, go, fakeDaemon } from './lib.mjs';
const P = '/tmp/serra-qa/profile';
const { app, page } = await launch({ profile: P, userData: '/tmp/serra-qa/ud' });
await page.waitForTimeout(1000);
await go(page, '/settings/diagnostics'); await page.waitForTimeout(800);
await page.getByRole('button', { name: 'Setup', exact: true }).click(); await page.waitForTimeout(800);
console.log('SETUP button ->', page.url().replace(/.*#/, '#'), (await text(page)).split('\n')[0]);
await go(page, '/jobs/needs-you'); await page.keyboard.press('Meta+k'); await page.waitForTimeout(300); await page.keyboard.type('setup'); await page.waitForTimeout(300); await page.keyboard.press('Enter'); await page.waitForTimeout(800);
console.log('SETUP ⌘K ->', page.url().replace(/.*#/, '#'));
// Repositories: add one
await go(page, '/settings/repositories'); await page.waitForTimeout(1000);
await page.getByRole('button', { name: 'Add repository' }).click(); await page.waitForTimeout(400);
const fields = await page.evaluate(() => [...document.querySelectorAll('[data-serra-main] input')].map((e) => e.labels?.[0]?.textContent ?? e.getAttribute('aria-label') ?? e.placeholder));
console.log('REPO FIELDS:', fields);
const inputs = page.locator('[data-serra-main] input');
const n = await inputs.count();
// The new row's fields come after the main project's four: Name, Local path, Base ref, GitHub repository.
for (const [offset, value] of [[0, 'docs'], [1, '/tmp/serra-qa/project'], [2, 'origin/main'], [3, 'acme/docs']]) await inputs.nth(n - 4 + offset).fill(value);
await page.waitForTimeout(300);
const saves = page.getByRole('button', { name: 'Save' });
await saves.last().click(); await page.waitForTimeout(800);
console.log('REPOSITORIES saved:', JSON.stringify(JSON.parse(readFileSync(P + '/profile.json', 'utf8')).repositories), (await page.evaluate(() => document.body.innerText.match(/[^\n]*(saved|Saved|must|required)[^\n]*/g)))?.slice(-3));
await shot(page, 'G6-repository-added');
// Jobs rereads on a daemon event
const d = await fakeDaemon(P);
await go(page, '/jobs/needs-you'); await page.waitForTimeout(1500);
const state = JSON.parse(readFileSync(P + '/state.json', 'utf8'));
state['C0123456789:1700000000.000900'] = { ...Object.values(state)[0], t3ThreadId: 'qa-new-event', threadTs: '1700000000.000900', createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), ownerAskOpen: true };
writeFileSync(P + '/state.json', JSON.stringify(state, null, 2));
const before = (await text(page)).match(/Needs you \((\d+)\)/)?.[1];
d.send({ event: ['needs_owner', { key: 'C0123456789:1700000000.000900' }] }); await page.waitForTimeout(2500);
console.log('JOBS reread on event: needs you', before, '->', (await text(page)).match(/Needs you \((\d+)\)/)?.[1]);
await app.close(); await d.quit();
