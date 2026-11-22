import { launch, shot, text } from './lib.mjs';
const { app, page, logs } = await launch({ userData: '/tmp/serra-qa/ud-wizard' });
await page.waitForTimeout(1200);
// A1b: the welcome, then step 1
await shot(page, 'A1b-setup-welcome');
await page.getByRole('button', { name: 'Get started' }).click();
await page.waitForTimeout(600);
// A2: empty submit shows validation
await page.getByRole('button', { name: 'Create profile' }).click();
await page.waitForTimeout(300);
console.log('ERRS', await page.evaluate(() => [...document.querySelectorAll('[aria-invalid=true]')].map((e) => document.querySelector(`label[for="${e.id}"]`)?.textContent + ': ' + document.getElementById(e.id + '-note')?.textContent)));
await shot(page, 'A2-wizard-validation');
// A3: relative path
await page.getByLabel('Name', { exact: true }).fill('QA Bot');
await page.getByLabel('Your name', { exact: true }).fill('QA Owner');
await page.getByLabel('Slack member ID', { exact: true }).fill('U0123456789');
await page.getByLabel('Folder', { exact: true }).fill('/tmp/serra-qa/project');
await page.getByLabel('Folder', { exact: true }).blur();
await page.waitForTimeout(1500);
console.log('DETECTED', await page.getByLabel('Base branch', { exact: true }).inputValue(), await page.getByLabel('GitHub repository', { exact: true }).inputValue());
await page.getByText('More options').click();
await page.getByLabel('Profile folder', { exact: true }).fill('/tmp/serra-qa/profile');
await page.getByLabel('T3 CLI', { exact: true }).fill('/tmp/serra-qa/bin/t3');
await shot(page, 'A3-wizard-filled');
await page.getByRole('button', { name: 'Create profile' }).click();
await page.waitForTimeout(2000);
console.log((await text(page)).slice(0, 2500));
await shot(page, 'A4-wizard-slack-step');
await app.close();
console.log(logs.join('').split('\n').filter((l) => !/Debugger|For help|DevTools/.test(l)).join('\n').slice(-2000));
