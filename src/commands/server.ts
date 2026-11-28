import type { Command } from '../manage.ts';
import { diagnoseHost, formatHostChecks } from '../server-doctor.ts';

const command: Command = {
  summary: 'Check that this computer can run Serra in the background. Changes nothing.',
  usage: ['pnpm bot server doctor'],
  profile: false,
  async run({ args, log }) {
    const [, action, ...extra] = args;
    if (action !== 'doctor' || extra.length) throw new Error('Use: pnpm bot server doctor');
    const checks = await diagnoseHost();
    log(formatHostChecks(checks));
    if (checks.some((check) => check.state === 'fail')) throw new Error('Fix the items marked FAIL, then run this again.');
  },
};
export default command;
