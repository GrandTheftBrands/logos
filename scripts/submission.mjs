// Validates a submission issue end to end. Used when it's opened/edited and again on approval.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { ROOT, checkExtra, checkLogo, download, parseIssueForm, readSubmission, taxonomy } from './lib.mjs';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Attachments in private repos 404 for bots. The API's rendered issue HTML carries
 * short-lived signed links for them, so map each attachment's ID to its signed link.
 */
async function signedAttachmentUrls(issueNumber, token) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/issues/${issueNumber}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.full+json' },
  });
  const map = new Map();
  if (!res.ok) return map;
  const { body_html = '' } = await res.json();
  for (const [raw] of body_html.matchAll(/https:\/\/private-user-images\.githubusercontent\.com\/[^"'\s<>]+/g)) {
    const url = raw.replace(/&amp;/g, '&');
    const id = url.match(UUID)?.[0]?.toLowerCase();
    if (id) map.set(id, url);
  }
  return map;
}

export async function validateIssue(issue, token) {
  const sub = readSubmission(parseIssueForm(issue.body));
  const signed = await signedAttachmentUrls(issue.number, token);
  const fetchable = (url) => signed.get(url.match(UUID)?.[0]?.toLowerCase()) ?? url;
  const errors = [...sub.errors];
  const notes = [];
  const artist = issue.user.login.toLowerCase();

  let logo = null;
  if (sub.logoUrl) {
    try {
      logo = await checkLogo(await download(fetchable(sub.logoUrl), token));
      errors.push(...logo.errors);
    } catch (e) {
      errors.push(`Couldn't download the logo file. Try attaching it again. (${e.message})`);
    }
  }

  const extras = [];
  for (const [i, url] of sub.extraUrls.entries()) {
    try {
      const buf = await download(fetchable(url), token);
      const name = decodeURIComponent(url.split('/').pop().split('?')[0]) || `extra-${i + 1}`;
      const problems = checkExtra(buf, name);
      errors.push(...problems);
      if (!problems.length) extras.push({ name: name.replace(/[^\w.-]+/g, '-'), buf });
    } catch {
      errors.push(`Couldn't download extra file ${i + 1}. Try attaching it again.`);
    }
  }

  // Existing brand / version on the site
  if (sub.brand) {
    const brandFile = join(ROOT, 'brands', sub.brand, 'brand.yml');
    if (existsSync(brandFile)) {
      const existing = YAML.parse(readFileSync(brandFile, 'utf8'));
      const label = (list, id) => list.find((x) => x.id === id)?.label ?? id;
      if (sub.game && existing.game !== sub.game) {
        notes.push(`**${existing.name}** is already listed under ${label(taxonomy.games, existing.game)}, so it will stay there.`);
      }
      if (sub.category && existing.category !== sub.category) {
        notes.push(`**${existing.name}** is already in ${label(taxonomy.categories, existing.category)}, so it will stay there.`);
      }
    }
    if (sub.variant) {
      const variantDir = join(ROOT, 'brands', sub.brand, sub.variant);
      if (existsSync(join(variantDir, artist))) {
        notes.push('You already have a version of this logo. Approving this one will replace it.');
      } else if (existsSync(variantDir)) {
        notes.push('Someone else has already made this logo. Yours will be added as an alternate version.');
      }
    }
  }

  return { ...sub, errors, notes, artist, logo: errors.length ? null : logo, extras };
}
