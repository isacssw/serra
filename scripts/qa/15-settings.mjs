import { launch, shot, text, go } from './lib.mjs';
import { readFileSync } from 'node:fs';
const P = '/tmp/serra-qa/profile';
const prof = () => JSON.parse(readFileSync(P + '/profile.json', 'utf8'));
const { app, page, logs } = await launch({ profile: P, userData: '/tmp/serra-qa/ud' });
await page.waitForTimeout(1000);
const msgs = () => page.evaluate(() => [...document.querySelectorAll('[data-serra-main] [role=alert], [data-serra-main] [aria-invalid=true] + p, [data-serra-main] p.text-down')].map((e) => e.textContent).filter(Boolean));
const toasts = () => page.evaluate(() => document.body.innerText.match(/[^\n]*(Saved|saved|Added|Removed|applies|Applies)[^\n]*/g)?.slice(-4));
// People
await go(page, '/settings/people'); await page.waitForTimeout(1000);
const field = page.getByPlaceholder('Slack member ID');
await field.fill('bad id'); await page.waitForTimeout(200);
console.log('BAD ID add disabled:', await page.getByRole('button', { name: 'Add person' }).isDisabled(), await msgs());
await field.fill('U0AAAAAAAAA'); await page.getByRole('button', { name: 'Add person' }).click(); await page.waitForTimeout(800);
console.log('ADDED:', prof().allowedUsers, await toasts());
await field.fill('U0AAAAAAAAA'); await page.waitForTimeout(300);
console.log('DUP disabled:', await page.getByRole('button', { name: 'Add person' }).isDisabled(), await msgs());
console.log('DUP:', prof().allowedUsers, await toasts());
await field.fill('U0123456789'); await page.waitForTimeout(300);
console.log('OWNER disabled:', await page.getByRole('button', { name: 'Add person' }).isDisabled(), await msgs());
console.log('OWNER ADD:', prof().allowedUsers, await toasts());
console.log('owner remove buttons:', await page.locator('[data-serra-main] tr', { hasText: 'U0123456789' }).getByRole('button').count());
await shot(page, 'G1-people-added');
await page.locator('[data-serra-main] tr', { hasText: 'U0AAAAAAAAA' }).getByRole('button').click(); await page.waitForTimeout(500);
const confirm = page.locator('dialog[open]').getByRole('button', { name: /Remove/ }); if (await confirm.count()) await confirm.click();
await page.waitForTimeout(800);
console.log('REMOVED:', prof().allowedUsers);
// Bot & Slack: invalid id
await go(page, '/settings/bot'); await page.waitForTimeout(1000);
// The bot ID is read-only on the page; Edit… opens a dialog that checks it before it reaches the form.
await page.getByRole('button', { name: 'Edit bot ID' }).click(); await page.waitForTimeout(300);
await page.locator('dialog[open]').getByLabel('Bot ID').fill('Bad ID!'); await page.waitForTimeout(300);
await page.locator('dialog[open]').getByRole('button', { name: 'Change' }).click(); await page.waitForTimeout(200);
console.log('BAD BOT ID:', await page.evaluate(() => [...document.querySelectorAll('dialog[open] [id$="-note"]')].map((e) => e.textContent)));
await shot(page, 'G2-bot-invalid');
await page.keyboard.press('Escape');
await page.getByLabel('Display name').fill('QA Bot Renamed'); await page.getByRole('button', { name: 'Save' }).first().click(); await page.waitForTimeout(800);
console.log('RENAMED:', prof().bot, await toasts());
await shot(page, 'G3-bot-saved-restart');
await page.getByLabel('Display name').fill('QA Bot'); await page.getByRole('button', { name: 'Save' }).first().click(); await page.waitForTimeout(800);
await page.getByLabel('Channel ID').fill('not-a-channel'); await page.waitForTimeout(300);
console.log('BAD CHANNEL:', await msgs());
// Alerts
await go(page, '/settings/alerts'); await page.waitForTimeout(1000);
await page.getByRole('button', { name: 'Add alert' }).first().click(); await page.waitForTimeout(500);
console.log('ALERT FORM:', await page.evaluate(() => [...document.querySelectorAll('dialog[open] input, dialog[open] textarea')].map((e) => (e.labels?.[0]?.textContent ?? e.getAttribute('aria-label') ?? e.placeholder) + '=' + e.value)));
await page.locator('dialog[open]').getByRole('button', { name: 'Add', exact: true }).click(); await page.waitForTimeout(300);
console.log('EMPTY ALERT kept open:', await page.locator('dialog[open]').count() === 1, await page.evaluate(() => [...document.querySelectorAll('dialog[open] [id$="-note"]')].map((e) => e.textContent)), JSON.stringify(prof().messageTriggers ?? null));
await shot(page, 'G4-alerts-empty-trigger');
// Worker
await go(page, '/settings/worker'); await page.waitForTimeout(1000);
await page.getByLabel('Pattern').fill('{slug}'); await page.waitForTimeout(300);
console.log('BAD PATTERN:', await msgs());
await page.getByText('Advanced', { exact: true }).click();
await page.getByLabel('Path', { exact: true }).fill('relative/t3'); await page.waitForTimeout(300);
console.log('RELATIVE T3:', await msgs());
// Repositories
await go(page, '/settings/repositories'); await page.waitForTimeout(1000);
await page.getByRole('button', { name: /^Edit / }).first().click(); await page.waitForTimeout(300);
await page.locator('dialog[open]').getByLabel('Base ref').fill(''); await page.locator('dialog[open]').getByRole('button', { name: 'Done' }).click(); await page.waitForTimeout(300);
console.log('EMPTY BASE:', await page.evaluate(() => [...document.querySelectorAll('dialog[open] [id$="-note"]')].map((e) => e.textContent)));
await shot(page, 'G5-repositories');
await app.close();
console.log(logs.filter((l) => /pageerror|console.error/.test(l)).join('\n'));
