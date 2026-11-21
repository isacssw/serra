// How the interview eval grades the proposals an interview wrote. No model in the loop: specific facts, and the
// audience the simulated owner chose (evals/persona.md). Shared by interview.ts and regrade-interviews.ts.
import { frontmatter } from '../src/knowledge-rules.ts';
import { compileAboutMe, pageAudience } from '../src/owner-model.ts';

export type InterviewScores = Record<string, number | null>;

export const gradeInterview = (proposals: { file: string; text: string }[], offersSamples: boolean): InterviewScores => {
  const all = proposals.map((p) => p.text).join('\n');
  const targetOf = (text: string): string => frontmatter(text)?.get('target')?.trim() ?? '';

  const person = (name: string, fact: RegExp): number => {
    const own = proposals.some((p) => /^people\//.test(targetOf(p.text)) && new RegExp(name, 'i').test(p.text) && fact.test(p.text));
    return own ? 1 : new RegExp(`${name}[\\s\\S]{0,200}`, 'i').test(all) && fact.test(all) ? 0.5 : 0;
  };
  const voicePage = proposals.find((p) => /voice/i.test(targetOf(p.text)) || /voice/i.test(p.file))?.text ?? '';
  const styleRules = [/exclamation/i, /British/i, /lead with|answer first|answer up front/i, /emoji/i, /hope this helps/i].filter((rule) => rule.test(voicePage)).length;
  const sampleGiven = /EUR and GBP are live|Webhook retries are fixed/.test(voicePage);
  const offlimits = (/(pay|salar|hiring|performance)/i.test(all) ? 0.5 : 0) + (/customer[\s\S]{0,80}date|date[\s\S]{0,80}customer|promise[\s\S]{0,40}date/i.test(all) ? 0.5 : 0);
  const audienceOf = (p: { text: string }): string => /^audience:\s*(owner|team|external)\s*$/m.exec(p.text)?.[1] ?? 'none';
  const expected = proposals.flatMap((p) => {
    if (/Platform team/i.test(p.text)) return [{ p, want: ['owner'] }];
    const target = targetOf(p.text);
    if (/^owner\/(role|working-style|voice|offlimits|decisions|priorities|goals)/.test(target)) return [{ p, want: ['team'] }];
    if (/^people\//.test(target) && /Priya|Jonas/i.test(p.text)) return [{ p, want: ['team'] }];
    return [];
  });
  const asPages = proposals.map((p) => ({ path: targetOf(p.text) || `owner/${p.file.replace(/^\d{4}-\d{2}-\d{2}-/, '')}`, text: p.text.replace(/^verified: no$/m, 'verified: 2026-11-21') }));
  const teamAbout = compileAboutMe(asPages, 'team', new Date('2026-11-21T10:00:00Z')).text;
  const teamFacts = [/staff engineer|tech lead/i, /Tuesday/, /exclamation/i, /Priya/].filter((fact) => fact.test(teamAbout)).length;
  const privateCaptured = proposals.filter((p) => /Platform team/i.test(p.text));

  return {
    people: (person('Priya', /product manager|scope/i) + person('Jonas', /reliability|SRE|on-?call|sign/i) + person('Dana', /Brightmoor|finance/i)) / 3,
    voice: Math.min(styleRules, 3) / 3,
    samples: offersSamples ? (sampleGiven ? 1 : 0) : (sampleGiven ? 0 : 1),
    offlimits,
    audience: expected.length ? expected.filter(({ p, want }) => want.includes(audienceOf(p))).length / expected.length : 0,
    team: teamFacts / 4,
    private: privateCaptured.length ? (privateCaptured.every((p) => pageAudience(frontmatter(p.text)) === 'owner') ? 1 : 0) : null,
  };
};
