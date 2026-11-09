// Merges a submission pull request about 10 minutes after its latest approval (.github/workflows/auto-merge.yml).
// Runs from main's copy of this script, never the pull request's. Every check below must pass;
// otherwise it says why on the pull request and leaves it for a person to merge.
import { execFileSync } from 'node:child_process';
import { ROOT, github, upsertComment } from './lib.mjs';

const token = process.env.GITHUB_TOKEN;
const api = github(token);
const prNumber = process.env.PR ?? '';
const sha = process.env.SHA ?? '';
if (!/^\d+$/.test(prNumber) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('PR must be a number and SHA a full commit hash');

const [owner, name] = process.env.GITHUB_REPOSITORY.split('/');
const WRITE = ['write', 'maintain', 'admin'];

const pr = await api(`/repos/{repo}/pulls/${prNumber}`);
// Merged, closed or replaced by a newer combined pull request: nothing to do
if (!pr || pr.state !== 'open') process.exit(0);
// Changed since this countdown started (a newer approval starts its own)
if (pr.head.sha !== sha) process.exit(0);

const problems = [];
if (!pr.head.ref.startsWith('submission/') || pr.base.ref !== 'main' || pr.head.repo?.full_name !== pr.base.repo.full_name || pr.draft) {
  problems.push('it isn’t a submission pull request from the bot into `main`');
}
if (pr.labels.some((l) => l.name === 'hold')) problems.push('it has the **hold** label');

// Only the bot's commits, and only logo files
const commits = (await api(`/repos/{repo}/pulls/${prNumber}/commits?per_page=100`)) ?? [];
if (commits.length === 0 || commits.some((c) => c.author?.type !== 'Bot')) problems.push('it has commits that weren’t made by the bot');
const files = (await api(`/repos/{repo}/pulls/${prNumber}/files?per_page=100`)) ?? [];
if (files.length === 0 || files.length >= 100 || files.some((f) => !f.filename.startsWith('brands/'))) {
  problems.push('it changes files outside `brands/`');
}

// Every submission in it: still approved, by a person who can approve, and not edited since
const numbers = [...new Set([...(pr.body ?? '').matchAll(/^- Closes #(\d+)/gm)].map((m) => m[1]))];
if (numbers.length === 0) problems.push('it doesn’t list any submissions');
for (const n of numbers) {
  const issue = await api(`/repos/{repo}/issues/${n}`);
  const labels = issue?.labels.map((l) => l.name) ?? [];
  if (!issue || issue.state !== 'open' || !labels.includes('submission') || !labels.includes('approved')) {
    problems.push(`#${n} is no longer an open, approved submission`);
    continue;
  }
  if (labels.includes('hold') || labels.includes('needs-changes')) problems.push(`#${n} is marked **${labels.includes('hold') ? 'hold' : 'needs-changes'}**`);

  const events = (await api(`/repos/{repo}/issues/${n}/events?per_page=100`)) ?? [];
  const approval = events.filter((e) => e.event === 'labeled' && e.label?.name === 'approved').pop();
  const approver = approval?.actor;
  if (!approver || approver.type !== 'User') {
    problems.push(`#${n} was approved automatically (Instant Approval), so a person merges it`);
    continue;
  }
  const perm = await api(`/repos/{repo}/collaborators/${approver.login}/permission`);
  if (!WRITE.includes(perm?.permission)) problems.push(`@${approver.login}, who approved #${n}, can no longer approve`);

  const edited = await api('/graphql', {
    method: 'POST',
    body: {
      query: 'query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){lastEditedAt}}}',
      variables: { owner, name, n: Number(n) },
    },
  });
  const lastEdit = edited?.data?.repository?.issue?.lastEditedAt;
  if (lastEdit && new Date(lastEdit) > new Date(approval.created_at)) problems.push(`#${n} was edited after it was approved`);
}

// The content check, on exactly the approved files, using main's scripts
if (problems.length === 0) {
  try {
    execFileSync('git', ['fetch', '--quiet', 'origin', sha], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('git', ['checkout', sha, '--', 'brands'], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('node', ['scripts/check-content.mjs'], { cwd: ROOT, stdio: 'inherit' });
  } catch {
    problems.push('the content check failed (see the Auto-Merge run’s log)');
  }
}

if (problems.length) {
  await upsertComment(api, Number(prNumber), [
    '### Not Merged Automatically',
    '',
    ...problems.map((p) => `- ${p}`),
    '',
    'A maintainer can still review and merge this by hand.',
  ].join('\n'));
  process.exit(0);
}

// Merge exactly the approved commit, then publish (merges by the bot don't start the usual rebuild)
await api(`/repos/{repo}/pulls/${prNumber}/merge`, { method: 'PUT', body: { sha, merge_method: 'merge' } });
await api(`/repos/{repo}/git/refs/heads/${pr.head.ref}`, { method: 'DELETE' }).catch(() => {});
await upsertComment(api, Number(prNumber), '### Merged Automatically\n\nEvery submission here was approved by a maintainer and passed the checks, so it was merged 10 minutes after the latest approval.');
if (process.env.CF_DEPLOY_HOOK) {
  const res = await fetch(process.env.CF_DEPLOY_HOOK, { method: 'POST' });
  if (!res.ok) throw new Error(`Site rebuild hook: HTTP ${res.status}`);
}
