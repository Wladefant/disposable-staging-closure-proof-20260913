const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Execute the shipped action script, not a second implementation of its parser.
const workflow = fs.readFileSync(path.join(__dirname, '../workflows/close-linked-issues.yml'), 'utf8');
const script = workflow.split('          script: |\n')[1].split('\n').map(line => line.slice(12)).join('\n');
const run = new (Object.getPrototypeOf(async function () {}).constructor)('github', 'context', 'core', script);
const sha = 'a'.repeat(40);

function scenario(body = 'Closes #1', options = {}) {
  const issue = { number: 1, state: 'open', labels: [], ...options.issue };
  const comments = options.comments || [];
  const calls = { close: 0, comment: 0, read: 0 };
  const pr = { number: 10, body, title: 'Closes #2; $(touch /tmp/unsafe)', merged: true,
    state: 'closed', merge_commit_sha: sha, commits: 0,
    base: { ref: 'staging', repo: { full_name: 'owner/repo' } },
    head: { repo: { full_name: 'owner/repo' } }, ...options.pr };
  const commits = options.commits || [];
  if (!options.pr?.commits) pr.commits = commits.length;
  const context = { repo: { owner: 'owner', repo: 'repo' }, eventName: 'pull_request',
    payload: { action: 'closed', pull_request: structuredClone(pr) } };
  Object.assign(context.payload.pull_request, options.event);
  const core = { info() {}, warning() {}, summary: {
    addHeading() { return this; }, addRaw() { return this; }, addTable() { return this; }, async write() {},
  } };
  const github = { rest: {
    pulls: { get: async () => ({ data: pr }), listCommits: 'commits' },
    repos: { getContent: async () => ({ data: { encoding: 'base64',
      content: Buffer.from(options.historical ? '# legacy workflow\n' : workflow).toString('base64') } }) },
    issues: {
      get: async ({ issue_number }) => {
        calls.read++;
        if (issue_number !== 1) throw Object.assign(new Error('missing'), { status: 404 });
        if (options.beforeRead) options.beforeRead(issue, calls);
        return { data: structuredClone(issue) };
      },
      listComments: 'comments',
      createComment: async ({ body }) => {
        calls.comment++;
        const comment = { id: calls.comment, body, user: { login: 'github-actions[bot]' } };
        comments.push(comment);
        return { data: comment };
      },
      updateComment: async ({ comment_id, body }) => { comments.find(c => c.id === comment_id).body = body; },
      update: async ({ state, state_reason }) => {
        if (options.failClose) throw new Error('network failure after comment');
        assert.equal(state_reason, 'completed'); calls.close++; issue.state = state;
      },
    },
  }, paginate: async method => method === 'commits' ? commits : comments };
  return { issue, comments, calls, context, github, pr, execute: () => run(github, context, core) };
}

test('body declaration closes once, cites full merge SHA, and replay writes nothing', async () => {
  const s = scenario('Closes #1\nFixes owner/repo#1');
  await s.execute(); await s.execute();
  assert.equal(s.issue.state, 'closed'); assert.equal(s.calls.close, 1); assert.equal(s.calls.comment, 1);
  assert.ok(s.comments[0].body.includes('https://github.com/owner/repo/commit/' + sha));
  assert.ok(s.comments[0].body.includes('https://github.com/owner/repo/pull/10'));
});

test('commit-only explicit declaration is acted on', async () => {
  const s = scenario('Only a reference #1', { commits: [{ parents: [{}], commit: { message: 'implementation\n\nResolved: https://github.com/OWNER/repo/issues/1' } }] });
  await s.execute(); assert.equal(s.issue.state, 'closed');
});

for (const body of ['Only #1', 'Do not close #1', 'Example: Closes #1', '`Closes #1`', '> Closes #1',
  'clo`example`ses #1', 'Closes `example` #1',
  '```text\nCloses #1\n```', '~~~\nCloses #1\n~~~', '```\nCloses #1', '<!-- Closes #1 -->',
  '<!--\nCloses #1', '    Closes #1', 'Closes #1oops', 'Closes #1/not-an-issue',
  'Closes https://github.com/owner/repo/issues/1?untrusted=1', 'Closes other/repo#1',
  'Fixes https://github.com/other/repo/issues/1', 'Close #0', 'Closes #9007199254740992']) {
  test('not an instruction: ' + JSON.stringify(body), async () => {
    const s = scenario(body); await s.execute(); assert.equal(s.calls.comment, 0); assert.equal(s.calls.close, 0);
  });
}

test('explicit list declarations and emphasis supported', async () => {
  for (const body of ['- [x] Fixes #1', '**Closes #1**', 'Closes #1, fixes owner/repo#1.',
    'Closes #1, #2', '- Fixes #1 — explanation with `code`', '### Fixed behavior (closes #1)',
    'Resolves #1. Use `<Link>` for navigation.', 'Fixes #1: probabilities summed to >100%.']) {
    const s = scenario(body); await s.execute(); assert.equal(s.calls.close, 1);
  }
});

test('attacker-controlled titles are not instructions', async () => {
  const s = scenario('');
  s.pr.title = 'Closes #1'; await s.execute(); assert.equal(s.calls.comment, 0);
});

for (const hold of ['needs:qa', 'state:needs-qa', 'needs-reproduction', 'needs-ddl-apply',
  'state:awaiting-auth', 'needs:decision', 'state:needs-decision', 'state:blocked']) {
  test(hold + ' wins over positive verification; loud and deduplicated', async () => {
    const s = scenario('Closes #1', { issue: { labels: [{ name: hold }, { name: 'state:live-verified' }] } });
    await s.execute(); await s.execute(); assert.equal(s.issue.state, 'open'); assert.equal(s.calls.comment, 1);
    assert.ok(s.comments[0].body.includes('pending')); assert.ok(s.comments[0].body.includes(hold));
    s.issue.labels = []; await s.execute(); assert.equal(s.calls.close, 0);
  });
}

test('testing is an area label, not an unverified state', async () => {
  const s = scenario('Closes #1', { issue: { labels: [{ name: 'testing' }] } });
  await s.execute(); assert.equal(s.calls.close, 1);
});

test('merely closed event, API-unmerged state, wrong base and fork never write', async () => {
  for (const options of [{ event: { merged: false } }, { pr: { merged: false } },
    { pr: { base: { ref: 'kalshi', repo: { full_name: 'owner/repo' } } } },
    { pr: { head: { repo: { full_name: 'attacker/repo' } } } }, { event: { merge_commit_sha: 'b'.repeat(40) } }]) {
    const s = scenario('Closes #1', options); await s.execute(); assert.equal(s.calls.comment, 0);
  }
});

test('PR references and already-closed issues never receive comments', async () => {
  for (const issue of [{ pull_request: {} }, { state: 'closed' }]) {
    const s = scenario('Closes #1', { issue }); await s.execute(); assert.equal(s.calls.comment, 0);
  }
});

test('historical workflow has no backfill, even when old parser would have skipped', async () => {
  const s = scenario('Closes owner/repo#1', { historical: true });
  await s.execute(); assert.equal(s.calls.read, 0); assert.equal(s.calls.comment, 0);
});

test('legacy bot receipt preserves open issue and does not duplicate a historical comment', async () => {
  const s = scenario('Closes #1', { comments: [{ body: 'Closed by https://github.com/owner/repo/pull/10, merged into `staging`.\n\nLegacy text.', user: { login: 'github-actions[bot]' } }] });
  await s.execute(); assert.equal(s.calls.close, 0); assert.equal(s.calls.comment, 0);
});

test('human reopening after successful v2 closure is never overridden', async () => {
  const s = scenario(); await s.execute(); s.issue.state = 'open'; await s.execute();
  assert.equal(s.issue.state, 'open'); assert.equal(s.calls.close, 1); assert.equal(s.calls.comment, 1);
});

test('partial failure preserves receipt without duplicate or unsafe retry closure', async () => {
  const s = scenario('Closes #1', { failClose: true });
  await assert.rejects(s.execute(), /network failure/); await s.execute();
  assert.equal(s.calls.comment, 1); assert.equal(s.issue.state, 'open'); assert.equal(s.calls.close, 0);
});

test('hold arriving during processing prevents closure', async () => {
  const s = scenario('Closes #1', { beforeRead: (issue, calls) => {
    if (calls.comment) issue.labels = [{ name: 'needs:qa' }];
  } });
  await s.execute(); assert.equal(s.calls.close, 0); assert.equal(s.calls.comment, 1);
  assert.ok(s.comments[0].body.includes('pending'));
});

test('API pagination capacity and incomplete commits fail before writes', async () => {
  for (const count of [2, 251]) {
    const s = scenario('Closes #1', { pr: { commits: count } });
    await assert.rejects(s.execute(), /[Cc]ommit/); assert.equal(s.calls.comment, 0);
  }
});
