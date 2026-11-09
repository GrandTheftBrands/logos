# Content structure

```
brands/<brand-slug>/
  brand.yml                     # name, game, category
  <variant>/<github-handle>/
    logo.svg  (or logo.png)     # source; SVG preferred — PNG/JPG/ZIP are generated from it
    meta.yml                    # artist, added, featured
    extras/                     # optional .eps / .gif / .mp4
```

**brand.yml**

| Field | Values |
|---|---|
| `name` | Display name, e.g. `Vice City Manatees` |
| `game` | `vi` `v` `iv` `iii` `sa` `vc` |
| `description` | Optional. One or two sentences shown on the brand's page and in search results (under 300 characters) |
| `category` | `game-logos` (the games' own logos) `business` `food` `apps-web` `radio` `vehicles` `locations` `weapons` `sports` `media` `fashion` `government` `emergency` `organisations` |

**Variant folders** (one logo each): `primary` `icon` `wordmark` `text-lockup` `horizontal-lockup` `vertical-lockup` `badge`, or `other-<name>`. More than one of a type adds a name or number: `icon-alternate`, `icon-2`.

**meta.yml**

| Field | Meaning |
|---|---|
| `artist` | GitHub handle credited on the site (same as the folder name) |
| `added` | When it was approved: UTC time `YYYY-MM-DDTHH:MM:SSZ` (set by the bot), or just `YYYY-MM-DD` |
| `updated` | When the file was last updated, if ever (set by the Update a Logo form), same format |
| `featured` | `true` for the version shown in grids when a variant has several artists |
| `lore` | `canon` (appears in the game) or `fanon` (fan-made / inspired) |
| `label` | Display name when the folder isn't a plain type, e.g. `ESU Patch`, `Icon (Alternate)`, `Icon 2` |
