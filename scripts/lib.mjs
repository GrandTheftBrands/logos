// Shared helpers for the submission workflows and the content check.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import sharp from 'sharp';

export const ROOT = resolve(import.meta.dirname, '..');
export const taxonomy = JSON.parse(readFileSync(resolve(ROOT, 'taxonomy.json'), 'utf8'));

export const LIMITS = {
  svgBytes: 2 * 1024 ** 2,
  pngBytes: 20 * 1024 ** 2,
  pngMinEdge: 1024,
  extraBytes: 20 * 1024 ** 2, // Cloudflare Pages serves files up to 25 MiB
  extraTypes: ['gif', 'mp4', 'eps'],
};

export const slugify = (s) =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const idFor = (list, label) => list.find((x) => x.label === label)?.id;

// ---------- Issue form parsing ----------

/** Splits a rendered issue form ("### Label\n\nvalue") into { label: value }. */
export function parseIssueForm(body = '') {
  const fields = {};
  for (const block of body.split(/^### /m).slice(1)) {
    const [label, ...rest] = block.split('\n');
    const value = rest.join('\n').trim();
    fields[label.trim()] = value === '_No response_' ? '' : value;
  }
  return fields;
}

const ATTACHMENT = /https:\/\/(?:github\.com\/user-attachments\/(?:assets|files)\/[^\s)"'<>]+|(?:private-)?user-images\.githubusercontent\.com\/[^\s)"'<>]+)/g;
export const attachmentUrls = (text = '') => [...new Set(text.match(ATTACHMENT) ?? [])];

/** Turns the parsed form into a submission, collecting every problem rather than stopping at the first. */
export function readSubmission(fields) {
  const errors = [];
  const brandName = fields['Brand Name']?.trim();
  if (!brandName) errors.push('**Brand Name** is empty.');

  const game = idFor(taxonomy.games, fields['Game']);
  if (!game) errors.push('Pick a **Game** from the list.');
  const category = idFor(taxonomy.categories, fields['Category']);
  if (!category) errors.push('Pick a **Category** from the list.');

  let variant = idFor(taxonomy.variants, fields['Logo Type']);
  let variantLabel = fields['Logo Type'];
  if (!variant) errors.push('Pick a **Logo Type** from the list.');
  if (variant === 'other') {
    const name = fields['Logo Type Name (Only if "Other")']?.trim();
    if (!name) errors.push('You picked **Other** as the logo type. Fill in **Logo Type Name** too.');
    else {
      variant = `other-${slugify(name)}`;
      variantLabel = name;
    }
  }

  const lore = idFor(taxonomy.lore, fields['Canon or Fanon']);
  if (!lore) errors.push('Pick **Canon** or **Fanon**.');

  const brandDescription = (fields['Brand Description (Optional)'] ?? '').split(/\s+/).join(' ').trim();
  if (brandDescription.length > 300) errors.push('**Brand Description** is too long. Keep it under 300 characters.');

  const logoUrls = attachmentUrls(fields['Logo File']);
  if (logoUrls.length === 0) errors.push('No file found in **Logo File**. Drag your SVG, PNG or .zip into that box.');
  if (logoUrls.length > 1) errors.push('**Logo File** has more than one attachment. Attach one logo per submission.');

  const confirmed = (fields['Confirm'] ?? '').match(/- \[x\]/gi)?.length ?? 0;
  if (confirmed < 3) errors.push('Tick all three boxes under **Confirm**.');

  return {
    errors,
    brandName,
    brand: brandName ? slugify(brandName) : '',
    game,
    category,
    variant,
    variantLabel,
    lore,
    brandDescription,
    logoUrl: logoUrls[0],
    extraUrls: attachmentUrls(fields['Extra Files (Optional)']),
  };
}

/** Reads the "Update a Logo" form. Brand details come from the existing files, not the form. */
export function readUpdate(fields) {
  const errors = [];
  const page = fields['Logo Page']?.trim() ?? '';
  const match = page.match(/\/brands\/([a-z0-9-]+)\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?\/?(?:[?#].*)?$/i);
  if (!match) errors.push('**Logo Page** should be a link to the logo, like `…/brands/vice-city-manatees/primary`.');

  const logoUrls = attachmentUrls(fields['New Logo File']);
  if (logoUrls.length === 0) errors.push('No file found in **New Logo File**. Drag your SVG, PNG or .zip into that box.');
  if (logoUrls.length > 1) errors.push('**New Logo File** has more than one attachment. Attach one logo.');

  if (!fields["What's Changing?"]?.trim()) errors.push("Say what's changing under **What's Changing?**.");

  const confirmed = (fields['Confirm'] ?? '').match(/- \[x\]/gi)?.length ?? 0;
  if (confirmed < 3) errors.push('Tick all three boxes under **Confirm**.');

  return {
    errors,
    brand: match?.[1]?.toLowerCase() ?? '',
    variant: match?.[2]?.toLowerCase() ?? '',
    pageArtist: match?.[3]?.toLowerCase(),
    changes: fields["What's Changing?"]?.trim() ?? '',
    logoUrl: logoUrls[0],
    extraUrls: attachmentUrls(fields['Extra Files (Optional)']),
  };
}

// ---------- File checks ----------

export function sniff(buf) {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'zip';
  if (buf.subarray(0, 6).toString('ascii') === 'GIF89a' || buf.subarray(0, 6).toString('ascii') === 'GIF87a') return 'gif';
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4';
  if (buf.subarray(0, 4).toString('ascii') === '%!PS' || buf.subarray(0, 4).equals(Buffer.from([0xc5, 0xd0, 0xd3, 0xc6]))) return 'eps';
  const head = buf.subarray(0, 2048).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg';
  return 'unknown';
}

/** Reasons an SVG is unsafe to serve or isn't a true vector. Empty array means OK. */
export function svgProblems(text) {
  const checks = [
    [/<script[\s>]/i, 'contains a `<script>` tag'],
    [/\son[a-z]+\s*=/i, 'contains event handler attributes (like `onclick`)'],
    [/javascript:/i, 'contains a `javascript:` link'],
    [/<(foreignObject|iframe|embed|object)[\s>]/i, 'contains embedded HTML (`foreignObject`, `iframe`, `embed` or `object`)'],
    [/<!ENTITY/i, 'declares XML entities'],
    [/(?:xlink:)?href\s*=\s*["']\s*(?:https?:)?\/\//i, 'links to an external file'],
    [/url\(\s*["']?\s*(?:https?:)?\/\//i, 'loads an external resource in its styles'],
    [/@import/i, 'imports external styles'],
    [/<image[^>]+href\s*=\s*["']data:/i, 'embeds a bitmap image, so it isn’t a real vector. Export the artwork as paths instead'],
    [/<text[\s>]/i, 'contains live text. Convert text to outlines/paths so it looks the same everywhere'],
  ];
  return checks.filter(([re]) => re.test(text)).map(([, msg]) => `The SVG ${msg}.`);
}

/** Validates a logo buffer. Unzips a .zip holding one SVG or PNG. */
export async function checkLogo(buf) {
  const errors = [];
  let type = sniff(buf);

  if (type === 'zip') {
    const files = Object.entries(unzipSync(new Uint8Array(buf)))
      .filter(([name]) => !name.startsWith('__MACOSX') && /\.(svg|png)$/i.test(name));
    if (files.length !== 1) return { errors: ['The .zip must contain exactly one SVG or PNG.'] };
    buf = Buffer.from(files[0][1]);
    type = sniff(buf);
  }

  if (type === 'svg') {
    if (buf.length > LIMITS.svgBytes) errors.push(`The SVG is ${(buf.length / 1024 ** 2).toFixed(1)} MB. The limit is 2 MB, so try simplifying paths.`);
    errors.push(...svgProblems(buf.toString('utf8')));
  } else if (type === 'png') {
    if (buf.length > LIMITS.pngBytes) errors.push('The PNG is over 20 MB.');
  } else {
    return { errors: ['The logo must be an SVG or PNG (or a .zip containing one).'] };
  }

  let meta;
  try {
    meta = await sharp(buf).metadata();
  } catch {
    return { errors: [...errors, `The ${type.toUpperCase()} couldn't be opened. It may be damaged.`] };
  }
  if (type === 'png') {
    const edge = Math.max(meta.width, meta.height);
    if (edge < LIMITS.pngMinEdge) errors.push(`The PNG is ${meta.width} × ${meta.height}. It needs to be at least ${LIMITS.pngMinEdge}px on its longest side.`);
    if (!meta.hasAlpha) errors.push('The PNG has no transparency. Export it with a transparent background.');
  }
  return { errors, type, buf, width: meta.width, height: meta.height };
}

export function checkExtra(buf, name) {
  const type = sniff(buf);
  if (!LIMITS.extraTypes.includes(type)) return [`**${name}** isn't a GIF, MP4 or EPS.`];
  if (buf.length > LIMITS.extraBytes) return [`**${name}** is over 20 MB.`];
  return [];
}

/** Current (left) and new (right) on the site's dark background, for updates. */
export async function renderComparison(oldBuf, newBuf) {
  const W = 1200, H = 600, PAD = 60, box = W / 2 - PAD * 2;
  const fit = async (buf) => {
    const png = await sharp(buf, { density: 300 }).resize(box, H - PAD * 2, { fit: 'inside' }).png().toBuffer();
    const { width, height } = await sharp(png).metadata();
    return { png, left: Math.round((W / 2 - width) / 2), top: Math.round((H - height) / 2) };
  };
  const [a, b] = await Promise.all([fit(oldBuf), fit(newBuf)]);
  return sharp({ create: { width: W, height: H, channels: 4, background: '#201938' } })
    .composite([
      { input: { create: { width: 2, height: H - PAD * 2, channels: 4, background: '#ffffff33' } }, left: W / 2 - 1, top: PAD },
      { input: a.png, left: a.left, top: a.top },
      { input: b.png, left: W / 2 + b.left, top: b.top },
    ])
    .png()
    .toBuffer();
}

/** Dark and light side by side, like the site's preview toggle. */
export async function renderPreview(buf) {
  const W = 1200, H = 600, PAD = 60, box = W / 2 - PAD * 2;
  const logo = await sharp(buf, { density: 300 }).resize(box, H - PAD * 2, { fit: 'inside' }).png().toBuffer();
  const { width, height } = await sharp(logo).metadata();
  const left = Math.round((W / 2 - width) / 2), top = Math.round((H - height) / 2);
  return sharp({ create: { width: W, height: H, channels: 4, background: '#201938' } })
    .composite([
      { input: { create: { width: W / 2, height: H, channels: 4, background: '#f4f3fb' } }, left: W / 2, top: 0 },
      { input: logo, left, top },
      { input: logo, left: W / 2 + left, top },
    ])
    .png()
    .toBuffer();
}

// ---------- GitHub ----------

export async function download(url, token) {
  // Only send the token to GitHub itself; signed attachment links carry their own auth
  const auth = token && new URL(url).hostname === 'github.com' ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(url, { headers: auth, redirect: 'follow' });
  if (!res.ok) throw new Error(`Couldn't download ${url} (HTTP ${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

export function github(token, repo = process.env.GITHUB_REPOSITORY) {
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(`https://api.github.com${path.replace('{repo}', repo)}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
}

const MARKER = '<!-- gtb-bot -->';

/** Creates or updates the bot's single status comment on an issue. */
export async function upsertComment(api, issue, body) {
  const comments = (await api(`/repos/{repo}/issues/${issue}/comments?per_page=100`)) ?? [];
  const mine = comments.find((c) => c.body?.startsWith(MARKER));
  const text = `${MARKER}\n${body}`;
  if (mine) await api(`/repos/{repo}/issues/comments/${mine.id}`, { method: 'PATCH', body: { body: text } });
  else await api(`/repos/{repo}/issues/${issue}/comments`, { method: 'POST', body: { body: text } });
}

export async function setLabels(api, issue, add = [], remove = []) {
  for (const name of remove) {
    await api(`/repos/{repo}/issues/${issue}/labels/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {});
  }
  if (add.length) await api(`/repos/{repo}/issues/${issue}/labels`, { method: 'POST', body: { labels: add } });
}
