// When a maintainer labels a submission "approved": re-check it, add the files, open a PR.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { ROOT, github, setLabels, upsertComment } from './lib.mjs';
import { validateIssue } from './submission.mjs';

const token = process.env.GITHUB_TOKEN;
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const { issue, sender } = event;
const api = github(token);
const git = (...args) => execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' });

if (event.label?.name !== 'approved' || !issue.labels.some((l) => l.name === 'submission')) process.exit(0);

// Only people with write access can approve
const perm = await api(`/repos/{repo}/collaborators/${sender.login}/permission`);
if (!['admin', 'maintain', 'write'].includes(perm?.permission)) {
  await setLabels(api, issue.number, [], ['approved']);
  process.exit(0);
}

const result = await validateIssue(issue, token);
if (result.errors.length) {
  await upsertComment(api, issue.number, [
    '### Can’t Publish Yet',
    '',
    ...result.errors.map((e) => `- ${e}`),
    '',
    'The **approved** label was removed. Fix these by editing the issue, then approve again.',
  ].join('\n'));
  await setLabels(api, issue.number, ['needs-changes'], ['approved', 'ready-for-review']);
  process.exit(0);
}

const { brand, variant, artist, logo } = result;
const brandDir = join(ROOT, 'brands', brand);
const variantDir = join(brandDir, variant);
const dir = join(variantDir, artist);

if (!existsSync(join(brandDir, 'brand.yml'))) {
  mkdirSync(brandDir, { recursive: true });
  writeFileSync(join(brandDir, 'brand.yml'), YAML.stringify({ name: result.brandName, game: result.game, category: result.category }));
}

// The first version of a logo is featured; later artists' versions are alternates
const hasOthers = existsSync(variantDir) && readdirSync(variantDir).some((d) => d !== artist);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `logo.${logo.type}`), logo.buf);
writeFileSync(join(dir, 'meta.yml'), YAML.stringify({
  artist,
  added: new Date().toISOString().slice(0, 10),
  featured: !hasOthers,
}));
if (result.extras.length) {
  mkdirSync(join(dir, 'extras'));
  for (const e of result.extras) writeFileSync(join(dir, 'extras', e.name), e.buf);
}

const branch = `submission/${issue.number}`;
const title = `Add ${result.brandName} ${result.variantLabel} by @${issue.user.login}`;
git('checkout', '-B', branch);
git('add', 'brands');
git('commit', '-m', `${title}\n\nCloses #${issue.number}\n\nCo-authored-by: ${issue.user.login} <${issue.user.id}+${issue.user.login}@users.noreply.github.com>`);
git('push', '--force', 'origin', branch);

const [owner] = process.env.GITHUB_REPOSITORY.split('/');
const open = await api(`/repos/{repo}/pulls?head=${owner}:${branch}&state=open`);
const pr = open?.[0] ?? (await api('/repos/{repo}/pulls', {
  method: 'POST',
  body: {
    title,
    head: branch,
    base: 'main',
    body: `Closes #${issue.number}\n\nSubmitted by @${issue.user.login}, approved by @${sender.login}.${result.notes.length ? `\n\n${result.notes.map((n) => `> ${n}`).join('\n')}` : ''}`,
  },
}));

await upsertComment(api, issue.number, `### Approved\n\nThanks @${issue.user.login}! It’s in pull request #${pr.number}, and goes live on the site as soon as that’s merged.`);
