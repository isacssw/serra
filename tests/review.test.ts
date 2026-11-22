import assert from 'node:assert/strict';
import test from 'node:test';
import { handleReviewRequest } from '../src/review.ts';
import type { run } from '../src/t3.ts';
import { createFakeSlack } from './fakes/slack.ts';

const options = { channel: 'C123', owner: 'U123', botName: 'Friday', repositories: ['acme/project'], githubLogin: 'alex', alreadyPosted: [], sourceLink: 'https://slack.test/thread' };
const request = '<review-request>Change https://github.com/acme/project/pull/12 <!channel></review-request>';
const fixture = (author = 'alex', draft = false, login = 'alex') => {
  const slack = createFakeSlack();
  slack.client.chat.getPermalink = async () => ({ ok: true, permalink: 'https://slack.test/review' });
  const { client } = slack;
  const posts = slack.posted;
  const command: typeof run = async (_cmd, args) => args[0] === 'api' ? login : JSON.stringify({ state: 'OPEN', isDraft: draft, author: { login: author } });
  return { client, command, posts };
};

test('posts a custom-owner PR once, with the chosen bot name and broadcasts removed', async () => {
  const { client, command, posts } = fixture();
  const result = await handleReviewRequest(client, request, options, command);
  assert.equal(result.postedFor, 'https://github.com/acme/project/pull/12'); assert.equal(posts.length, 1);
  assert.match(JSON.stringify(posts), /Prepared by Friday/); assert.doesNotMatch(JSON.stringify(posts), /<!channel>/);
  await handleReviewRequest(client, request, { ...options, alreadyPosted: [result.postedFor!] }, command);
  assert.equal(posts.length, 1);
});

test('disabled posting, foreign repositories, drafts, wrong authors and wrong CLI accounts never post', async () => {
  for (const [author, draft, login] of [['alex', true, 'alex'], ['other', false, 'alex'], ['alex', false, 'other']] as const) {
    const f = fixture(author, draft, login);
    assert.match((await handleReviewRequest(f.client, request, options, f.command)).reply, /Needs owner:/);
    assert.equal(f.posts.length, 0);
  }
  const f = fixture();
  await handleReviewRequest(f.client, request, { ...options, channel: undefined }, f.command);
  await handleReviewRequest(f.client, request.replace('acme/project', 'another/repo'), options, f.command);
  await handleReviewRequest(f.client, request.replace('</review-request>', ' https://github.com/another/repo/pull/1</review-request>'), options, f.command);
  assert.equal(f.posts.length, 0);
});
