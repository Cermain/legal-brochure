# cermain.com — Notion-fed blog

The blog on cermain.com is **generated at build time** from a shared Notion
database. You write a post once in Notion; a GitHub Action turns it into static
HTML on the site. There is **no live backend** and **no token in the browser**.

---

## How it works

```
Notion DB ──(GitHub Action, build time)──> blog.html + /blog/<slug>.html  ──> GitHub Pages
   ▲                                              ▲
   │ you write here                               │ committed static files (safe to be public)
```

- `scripts/build-blog.mjs` — reads the DB with the secret token, downloads images
  locally (Notion image URLs expire ~1h, so they must never be written into the
  HTML), renders posts, and regenerates `blog.html` + one page per post.
- `.github/workflows/build-blog.yml` — runs the script **daily** and on a manual
  **Run workflow** click, then commits the regenerated files.

## One-time setup

1. **Create a Notion internal integration** and share the blog database with it.
2. In GitHub: **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `NOTION_BLOG_TOKEN`
   - Value: the integration token (`ntn_…` / `secret_…`)
3. Done. The DB id is already in the script (it is not secret); the **token is the
   only secret** and lives only in Actions.

## Publishing a post

1. In Notion: set **Published** ✓, fill **Title**, **Slug**, **Date**, **Excerpt**,
   **Channel** (`Practice` or `Mirror`), and **Topics**.
2. Either wait for the daily run, or go to **Actions → Build blog from Notion →
   Run workflow** for an immediate (~1 min) publish.

## Notion schema (exact)

| Property        | Type          | Use |
|-----------------|---------------|-----|
| Title           | title         | Post title |
| Slug            | rich_text     | URL → `/blog/<slug>.html` (falls back to a slugified title) |
| Published       | checkbox      | **Only `true` posts are shown** |
| Date            | date          | Sort + displayed date |
| Excerpt         | rich_text     | Standfirst + `og:description` |
| Channel         | select        | `Practice` → legal stream · `Mirror` → Personal stream |
| Show on mimicu  | checkbox      | **Ignored on cermain.com** (mimicu's gate only) |
| Topics          | multi_select  | Rendered as tags |

- DB id: `a0b67e45d9f54b25919a96615791ede1`
- Data source: `b4953bac-2735-44b3-82c6-5690522f7e5a`

## Streams

All `Published` posts appear, split by **Channel**:
- **Practice** — OLN navy/sage, the "notes from practice" legal writing.
- **Personal (Mirror)** — *Beyond the Split* palette (cream `#EFE8D6`, navy
  `#16324C`, sage `#5E8A6C`), visually distinct so a personal essay doesn't jar
  mid-list, under one masthead. A toggle (All / Practice / Personal) filters the index.

## Newsletter

beehiiv "Beyond the Split" embed (script loader) appears in the subscribe band on
`blog.html` and under each post. The newsletter's home is cermain.com
(`read.cermain.com`).

## Security

- `NOTION_BLOG_TOKEN` is referenced **only** in the workflow via `secrets.…` and
  read **only** by the build step. It is never echoed, never written to a file,
  and never part of the committed output or the Pages build.
- The committed artifacts (`blog.html`, `/blog/*.html`, `/blog-assets/*`) contain
  no token and no Notion signed URLs — only local image paths.
- The DB id is **not** a secret; it cannot be queried without the token.

## Block types rendered

paragraph · heading 1/2/3 · bulleted/numbered lists · quote · image (downloaded
locally) · divider · code. Rich-text bold/italic/code/strikethrough/underline and
links are preserved. Unsupported block types are skipped.

## Default OG image

Posts without a cover use `/blog-assets/beyond-the-split-default.png`. Drop a
1200×630 image there (commit it once) so social cards are never blank.
