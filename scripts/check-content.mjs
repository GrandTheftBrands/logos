// Checks every logo under brands/ follows CONTENT.md. Runs on pull requests and pushes.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { ROOT, checkLogo, taxonomy } from './lib.mjs';

const errors = [];
const dirs = (p) => readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
const ids = (list) => list.map((x) => x.id);
const variantOk = (v) => (ids(taxonomy.variants).includes(v) && v !== 'other') || /^other-[a-z0-9]+(-[a-z0-9]+)*$/.test(v);
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;

let count = 0;
for (const brand of dirs(join(ROOT, 'brands'))) {
  const where = `brands/${brand}`;
  if (!SLUG.test(brand)) errors.push(`${where}: folder name must be lowercase-with-dashes`);
  const brandFile = join(ROOT, where, 'brand.yml');
  if (!existsSync(brandFile)) { errors.push(`${where}: missing brand.yml`); continue; }
  const info = YAML.parse(readFileSync(brandFile, 'utf8')) ?? {};
  if (!info.name) errors.push(`${where}/brand.yml: missing name`);
  if (!ids(taxonomy.games).includes(info.game)) errors.push(`${where}/brand.yml: game "${info.game}" isn't one of ${ids(taxonomy.games).join(', ')}`);
  if (!ids(taxonomy.categories).includes(info.category)) errors.push(`${where}/brand.yml: category "${info.category}" isn't one of ${ids(taxonomy.categories).join(', ')}`);

  for (const variant of dirs(join(ROOT, where))) {
    if (!variantOk(variant)) errors.push(`${where}/${variant}: unknown logo type (see CONTENT.md)`);
    const artists = dirs(join(ROOT, where, variant));
    const featured = [];
    for (const artist of artists) {
      const dir = join(ROOT, where, variant, artist);
      const at = `${where}/${variant}/${artist}`;
      if (!HANDLE.test(artist)) errors.push(`${at}: folder must be the artist's lowercase GitHub handle`);
      const meta = existsSync(join(dir, 'meta.yml')) ? YAML.parse(readFileSync(join(dir, 'meta.yml'), 'utf8')) ?? {} : null;
      if (!meta) { errors.push(`${at}: missing meta.yml`); continue; }
      if (meta.artist !== artist) errors.push(`${at}/meta.yml: artist must be "${artist}"`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(meta.added))) errors.push(`${at}/meta.yml: added must be a YYYY-MM-DD date`);
      if (meta.featured) featured.push(artist);

      const src = ['logo.svg', 'logo.png'].find((f) => existsSync(join(dir, f)));
      if (!src) { errors.push(`${at}: needs logo.svg or logo.png`); continue; }
      const result = await checkLogo(readFileSync(join(dir, src)));
      errors.push(...result.errors.map((e) => `${at}/${src}: ${e}`));
      count++;
    }
    // Approvals that race can leave two featured versions; the site picks the earliest, so just flag it
    if (artists.length > 1 && featured.length !== 1) {
      console.warn(`! ${where}/${variant}: ${featured.length} versions marked featured; the earliest added is shown. Set exactly one to tidy up.`);
    }
  }
}

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join('\n'));
  process.exit(1);
}
console.log(`✓ ${count} logos OK`);
