// When a maintainer labels a submission "approved": re-check it, then open one pull request
// holding every approved submission that isn't merged yet. If an earlier approval's PR is
// still open, it's closed and replaced by the new one, so there's only ever one to merge.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { ROOT, freeSlot, github, setLabels, taxonomy, upsertComment } from './lib.mjs';
import { validateIssue } from './submission.mjs';

const token = process.env.GITHUB_TOKEN;
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const { issue, sender } = event;
const api = github(token);
const git = (...args) => execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' });

// AUTO_APPROVE: the author has Instant Approval (checked by validate-submission.mjs just before)
const auto = process.env.AUTO_APPROVE === '1';
if ((!auto && event.label?.name !== 'approved') || !issue.labels.some((l) => l.name === 'submission')) process.exit(0);

// The bot labelling an Instant Approval itself was already handled by that run
if (!auto && sender.type === 'Bot') process.exit(0);

if (auto) {
  await setLabels(api, issue.number, ['approved']);
} else {
  // Only people with write access can approve
  const perm = await api(`/repos/{repo}/collaborators/${sender.login}/permission`);
  if (!['admin', 'maintain', 'write'].includes(perm?.permission)) {
    await setLabels(api, issue.number, [], ['approved']);
    process.exit(0);
  }
}

const cantPublish = async (number, errors) => {
  await upsertComment(api, number, [
    '### Can’t Publish Yet',
    '',
    ...errors.map((e) => `- ${e}`),
    '',
    'The **approved** label was removed. Fix these by editing the issue, then approve again.',
  ].join('\n'));
  await setLabels(api, number, ['needs-changes'], ['approved', 'ready-for-review']);
};

// Every approved submission still waiting, this one included. Rebuilding from all of them means
// an approval whose run was skipped (two approvals at once) is still picked up by the next one.
const waiting = (await api('/repos/{repo}/issues?state=open&labels=submission,approved&per_page=100')) ?? [];
if (!waiting.some((i) => i.number === issue.number)) waiting.push(issue);
waiting.sort((a, b) => a.number - b.number);

const batch = [];
const claimed = new Map(); // "brand/variant" → issue number already in this batch
for (const item of waiting) {
  const result = await validateIssue(item, token);
  if (result.errors.length) {
    await cantPublish(item.number, result.errors);
    continue;
  }

  if (result.isUpdate) {
    // Updates replace a live logo on purpose, but two in one batch mustn't touch the same one
    const key = `${result.brand}/${result.variant}`;
    if (claimed.has(key)) {
      await upsertComment(api, item.number, [
        '### Waiting on Another Update',
        '',
        `#${claimed.get(key)} is already updating **${result.brandName} ${result.variantLabel}**. Approve this one again after that's merged.`,
      ].join('\n'));
      await setLabels(api, item.number, [], ['approved']);
      continue;
    }
  } else if (item.labels.some((l) => l.name === 'replace')) {
    // A maintainer asked to overwrite the artist's logo in the requested slot itself
    Object.assign(result, { variant: result.requestedVariant, variantLabel: result.requestedLabel });
  } else {
    // Each submission is its own logo: the next free slot, counting the rest of this batch too
    Object.assign(result, freeSlot(result.brand, result.requestedVariant, result.requestedLabel, new Set(claimed.keys())));
  }
  claimed.set(`${result.brand}/${result.variant}`, item.number);
  batch.push({ issue: item, result });
}

// Nothing new to publish: leave any open PR as it is
if (!batch.some((b) => b.issue.number === issue.number)) process.exit(0);

// When each submission was approved (to the second), so same-day uploads keep their order.
// A batch is rebuilt on every approval, so this can't simply be "now".
const now = () => `${new Date().toISOString().slice(0, 19)}Z`;
const approvedAt = async (number) => {
  if (number === issue.number) return now();
  const events = (await api(`/repos/{repo}/issues/${number}/events?per_page=100`)) ?? [];
  const last = events.filter((e) => e.event === 'labeled' && e.label?.name === 'approved').pop();
  return last?.created_at ?? now();
};
for (const b of batch) b.at = await approvedAt(b.issue.number);

function writeFiles({ result, at }) {
  const { brand, variant, artist, logo } = result;
  const brandDir = join(ROOT, 'brands', brand);
  const variantDir = join(brandDir, variant);
  const dir = join(variantDir, artist);

  if (!existsSync(join(brandDir, 'brand.yml'))) {
    mkdirSync(brandDir, { recursive: true });
    writeFileSync(join(brandDir, 'brand.yml'), YAML.stringify({
      name: result.brandName,
      game: result.game,
      category: result.category,
      ...(result.brandDescription ? { description: result.brandDescription } : {}),
    }));
  }

  if (result.isUpdate) {
    // Swap the file, keep everything else; extras are replaced only if new ones were attached
    for (const f of ['logo.svg', 'logo.png']) rmSync(join(dir, f), { force: true });
    writeFileSync(join(dir, `logo.${logo.type}`), logo.buf);
    writeFileSync(join(dir, 'meta.yml'), YAML.stringify({ ...result.meta, updated: at }));
    if (result.extras.length) {
      rmSync(join(dir, 'extras'), { recursive: true, force: true });
      mkdirSync(join(dir, 'extras'));
      for (const e of result.extras) writeFileSync(join(dir, 'extras', e.name), e.buf);
    }
    return;
  }

  // The first version of a logo is featured; later artists' versions are alternates
  const hasOthers = existsSync(variantDir) && readdirSync(variantDir).some((d) => d !== artist);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `logo.${logo.type}`), logo.buf);
  writeFileSync(join(dir, 'meta.yml'), YAML.stringify({
    artist,
    added: at,
    featured: !hasOthers,
    lore: result.lore,
    // Keeps the exact wording ("ESU Patch", "Icon (Alternate)", "Icon 2"), which the folder name can't
    ...(taxonomy.variants.some((v) => v.id === variant) ? {} : { label: result.variantLabel }),
  }));
  if (result.extras.length) {
    mkdirSync(join(dir, 'extras'));
    for (const e of result.extras) writeFileSync(join(dir, 'extras', e.name), e.buf);
  }
}

const titleOf = ({ issue: i, result }) => `${result.isUpdate ? 'Update' : 'Add'} ${result.brandName} ${result.variantLabel} by @${i.user.login}`;

// One commit per submission, each crediting its artist
const numbers = batch.map((b) => b.issue.number);
const branch = `submission/${numbers.join('-')}`;
git('checkout', '-B', branch);
for (const b of batch) {
  writeFiles(b);
  git('add', 'brands');
  git('commit', '-m', `${titleOf(b)}\n\nCloses #${b.issue.number}\n\nCo-authored-by: ${b.issue.user.login} <${b.issue.user.id}+${b.issue.user.login}@users.noreply.github.com>`);
}
git('push', '--force', 'origin', branch);

const describe = (b) => [
  `- Closes #${b.issue.number}: ${titleOf(b)}`,
  ...(b.result.isUpdate ? [`  - **What's changing:** ${b.result.changes}`] : []),
  ...b.result.notes.map((n) => `  - ${n}`),
].join('\n');

const [owner] = process.env.GITHUB_REPOSITORY.split('/');
const existing = await api(`/repos/{repo}/pulls?head=${owner}:${branch}&state=open`);
const pr = existing?.[0] ?? (await api('/repos/{repo}/pulls', {
  method: 'POST',
  body: {
    title: batch.length === 1 ? titleOf(batch[0]) : `Add ${batch.length} Submissions (${numbers.map((n) => `#${n}`).join(', ')})`,
    head: branch,
    base: 'main',
    body: `${batch.map(describe).join('\n')}\n\n${auto ? `Latest: @${issue.user.login}'s submission, approved automatically (Instant Approval).` : `Latest approval by @${sender.login}.`} Merging publishes all of these at once.`,
  },
}));

// Close the PRs this one replaces
const open = (await api('/repos/{repo}/pulls?state=open&per_page=100')) ?? [];
for (const old of open.filter((p) => p.head.ref.startsWith('submission/') && p.number !== pr.number)) {
  await api(`/repos/{repo}/issues/${old.number}/comments`, { method: 'POST', body: { body: `Combined into #${pr.number} with the newest approval.` } });
  await api(`/repos/{repo}/pulls/${old.number}`, { method: 'PATCH', body: { state: 'closed' } });
  await api(`/repos/{repo}/git/refs/heads/${old.head.ref}`, { method: 'DELETE' }).catch(() => {});
}

for (const b of batch) {
  await setLabels(api, b.issue.number, [], ['needs-changes']);
  await upsertComment(api, b.issue.number, `### Approved\n\nThanks @${b.issue.user.login}! It’s in pull request #${pr.number}, and goes live on the site as soon as that’s merged.`);
}
