import { launch, shot, text } from './lib.mjs';
const { app, page, logs } = await launch({ userData: '/tmp/serra-qa/ud-wizard' });
await page.waitForTimeout(1200);
// Confirm you: with tokens that Slack rejects, the step stays open and says why. It needs the Slack step done first.
await page.evaluate(() => { location.hash = '/setup/owner'; }); await page.waitForTimeout(1500);
console.log('OWNER:', (await text(page)).split('Confirm it’s you').at(-1).slice(0, 400));
await shot(page, 'A9-setup-owner');
await page.locator('[data-setup-step="service"]').click(); await page.waitForTimeout(500);
console.log('SERVICE STEP:', (await text(page)).split('Install and start').at(-1).slice(0, 600));
const t0 = Date.now();
await page.getByRole('button', { name: /Install and start|Install again/ }).click();
for (let i = 0; i < 240; i++) { await page.waitForTimeout(1000); const t = await text(page); if (/Nothing was installed|didn’t start|Waiting for|is running/.test(t)) break; }
console.log('took', Math.round((Date.now() - t0) / 1000), 's');
console.log('LOG:', await page.evaluate(() => document.querySelector('[data-setup-log]')?.textContent?.slice(-2500)));
console.log('RESULT:', (await text(page)).split('Install and start').at(-1).slice(0, 800));
await shot(page, 'A10-setup-install-refused-preflight');
await app.close();
