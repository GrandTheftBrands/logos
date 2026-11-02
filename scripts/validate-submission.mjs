// On submission issues opened or edited: check the files, post a preview, set labels.
import { readFileSync } from 'node:fs';
import { github, renderPreview, setLabels, taxonomy, upsertComment } from './lib.mjs';
import { validateIssue } from './submission.mjs';

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const { issue } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const api = github(token);

if (issue.state !== 'open' || !issue.labels.some((l) => l.name === 'submission')) process.exit(0);

const result = await validateIssue(issue, token);
const label = (list, id) => list.find((x) => x.id === id)?.label ?? id;

if (result.errors.length) {
  await upsertComment(api, issue.number, [
    '### Needs Changes',
    '',
    ...result.errors.map((e) => `- ${e}`),
    '',
    'Edit this issue to fix these and I’ll check it again automatically.',
  ].join('\n'));
  await setLabels(api, issue.number, ['needs-changes'], ['ready-for-review']);
  process.exit(0);
}

// Store the preview on the "previews" branch so the comment can show it
const png = await renderPreview(result.logo.buf);
const path = `previews/${issue.number}.png`;
if (!(await api('/repos/{repo}/branches/previews'))) {
  const main = await api('/repos/{repo}/git/ref/heads/main');
  await api('/repos/{repo}/git/refs', { method: 'POST', body: { ref: 'refs/heads/previews', sha: main.object.sha } });
}
const existing = await api(`/repos/{repo}/contents/${path}?ref=previews`);
const put = await api(`/repos/{repo}/contents/${path}`, {
  method: 'PUT',
  body: {
    message: `Preview for #${issue.number}`,
    content: png.toString('base64'),
    branch: 'previews',
    ...(existing ? { sha: existing.sha } : {}),
  },
});
// github.com/…?raw=true (not raw.githubusercontent.com) also displays for members while the repo is private
const image = `https://github.com/${repo}/blob/previews/${path}?raw=true&v=${put.content.sha.slice(0, 7)}`;

const { logo } = result;
await upsertComment(api, issue.number, [
  '### Ready for Review',
  '',
  `![Preview of ${result.brandName} ${result.variantLabel} on dark and light backgrounds](${image})`,
  '',
  '| | |',
  '|---|---|',
  `| Brand | ${result.brandName} |`,
  `| Game | ${label(taxonomy.games, result.game)} |`,
  `| Category | ${label(taxonomy.categories, result.category)} |`,
  `| Logo Type | ${result.variantLabel} |`,
  `| File | ${logo.type.toUpperCase()}, ${logo.width} × ${logo.height}${logo.type === 'svg' ? ' (vector)' : ''} |`,
  ...(result.extras.length ? [`| Extras | ${result.extras.map((e) => e.name).join(', ')} |`] : []),
  `| Credited To | @${issue.user.login} |`,
  `| Page | \`/brands/${result.brand}/${result.variant}\` |`,
  '',
  ...result.notes.map((n) => `> ${n}`),
  ...(result.notes.length ? [''] : []),
  'A maintainer will review this soon. You can still edit the issue; I’ll re-check it.',
].join('\n'));
await setLabels(api, issue.number, ['ready-for-review'], ['needs-changes']);
