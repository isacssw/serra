// Brief and policy (APP-21), on the services in src/brief.ts. Handlers check the shape of what the window sent and
// call them. The preview goes through `fillBrief`/`fillBriefText` with the profile's config and knowledge index,
// the same call the daemon makes for a job. Tokens are read lazily by the config and are never touched here.
import { briefProblems, createBriefService, fillBrief, fillBriefText, isBriefDocument, sampleBriefInput, type BriefDocumentName } from '../../../src/brief.ts';
import { loadConfig } from '../../../src/config.ts';
import { createKnowledge } from '../../../src/knowledge.ts';
import type { Handlers } from '../bridge.ts';
import type { HandlerContext } from './context.ts';

const documentName = (value: unknown): BriefDocumentName => {
  if (!isBriefDocument(value)) throw new Error(`Unknown document: ${String(value)}. Use brief or policy.`);
  return value;
};

const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string') throw new Error(`${what} must be text.`);
  return value;
};

const nonEmpty = (value: unknown, what: string): string => {
  const result = text(value, what);
  if (!result.trim()) throw new Error(`${what} is missing.`);
  return result;
};

export const briefHandlers = (context: HandlerContext): Handlers<'brief'> => {
  // A new service per call: the profile folder can change while the app runs.
  const service = () => createBriefService({ profileDir: context.profileDir() });
  return {
    read: (document) => service().read(documentName(document)),
    save: (document, value) => { service().save(documentName(document), text(value, 'The text')); },
    check: (document, value) => briefProblems(documentName(document), text(value, 'The text')),
    preview: (request, draft) => {
      const config = loadConfig({ profileDir: context.profileDir(), env: {} });
      const index = createKnowledge(config.knowledgeDir).briefKnowledge('owner');
      const input = sampleBriefInput(config, nonEmpty(request, 'A sample request'));
      if (draft === undefined || draft === null) return fillBrief(config, index, input);
      const template = text(draft, 'The draft');
      const problems = briefProblems('brief', template);
      if (problems.length) throw new Error(problems.join(' '));
      return fillBriefText(template, config, index, input);
    },
    listProposed: () => service().listProposed(),
    readProposed: (name) => service().readProposed(nonEmpty(name, 'Proposal')),
    applyProposed: (name) => { service().applyProposed(nonEmpty(name, 'Proposal')); },
  };
};
