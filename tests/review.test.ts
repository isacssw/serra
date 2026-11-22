import assert from 'node:assert/strict';
import test from 'node:test';
import { handleReviewRequest, type PostReview } from '../src/review.ts';
import type { run } from '../src/t3.ts';
import { slackChat } from './fakes/chat.ts';
import { createFakeSlack } from './fakes/slack.ts';

const options = { repositories: ['acme/project'], githubLogin: 'alex', alreadyPosted: [] };
const request = '<review-request>Change https://github.com/acme/project/pull/12 <!channel></review-request>';
const fixture = (author = 'alex', draft = false, login = 'alex', outcome: Awaited<ReturnType<PostReview>> = { ok: true, link: 'https://slack.test/review' }) => {
  const posts: string[] = [];
  const post: PostReview = async (markdown) => { posts.push(markdown); return outcome; };
  const command: typeof run = async (_cmd, args) => args[0] === 'api' ? login : JSON.stringify({ state: 'OPEN', isDraft: draft, author: { login: author } });
  return { post, command, posts };
};

test('posts an owner\'s PR once, with broadcasts removed, and links the post', async () => {
  const { post, command, posts } = fixture();
  const result = await handleReviewRequest(request, { ...options, post }, command);
  assert.equal(result.postedFor, 'https://github.com/acme/project/pull/12'); assert.equal(posts.length, 1);
  assert.doesNotMatch(posts[0]!, /<!channel>/);
  assert.match(result.reply, /Review request posted: https:\/\/slack\.test\/review\./);
  await handleReviewRequest(request, { ...options, post, alreadyPosted: [result.postedFor!] }, command);
  assert.equal(posts.length, 1);
});

test('disabled posting, foreign repositories, drafts, wrong authors and wrong CLI accounts never post', async () => {
  for (const [author, draft, login] of [['alex', true, 'alex'], ['other', false, 'alex'], ['alex', false, 'other']] as const) {
    const f = fixture(author, draft, login);
    assert.match((await handleReviewRequest(request, { ...options, post: f.post }, f.command)).reply, /Needs owner:/);
    assert.equal(f.posts.length, 0);
  }
  const f = fixture();
  await handleReviewRequest(request, options, f.command);
  await handleReviewRequest(request.replace('acme/project', 'another/repo'), { ...options, post: f.post }, f.command);
  await handleReviewRequest(request.replace('</review-request>', ' https://github.com/another/repo/pull/1</review-request>'), { ...options, post: f.post }, f.command);
  assert.equal(f.posts.length, 0);
});

test('a request the review channel may not hear goes back to the owner to paste', async () => {
  const f = fixture('alex', false, 'alex', { ok: false, refused: true });
  const result = await handleReviewRequest(request, { ...options, post: f.post }, f.command);
  assert.equal(result.postedFor, null);
  assert.match(result.reply, /Needs owner: I couldn't post the review request \(it was written with knowledge some people in the review channel may not hear/);
});

test('Slack shows a review request as prepared by the bot for the owner, linking back to its thread', async () => {
  const slack = createFakeSlack();
  const { deliver } = slackChat(slack.client, { owner: 'U0123456789', botToken: 'xoxb-1111-2222-fixturevalue', profileDir: '/tmp' }, { botUserId: 'UBOT' });
  await deliver({ target: { conversation: 'CREVIEW', thread: null }, requester: 'U0123456789', hearing: { kind: 'thread', heard: {} } },
    { op: 'send', out: { kind: 'review', markdown: 'Change https://github.com/acme/project/pull/12', from: 'Friday', link: 'https://slack.test/thread' } });
  assert.equal(slack.posted.length, 1);
  assert.equal(slack.posted[0]!.channel, 'CREVIEW');
  assert.equal(slack.posted[0]!.thread_ts, undefined);
  assert.match(JSON.stringify(slack.posted[0]!.blocks), /Prepared by Friday for <@U0123456789> · <https:\/\/slack\.test\/thread\|request thread>/);
});
