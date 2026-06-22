#!/usr/bin/env node
/**
 * build-blog.mjs — Notion-fed static blog generator for cermain.com
 *
 * Runs at BUILD TIME ONLY (GitHub Actions). Reads the shared Notion DB with a
 * server-side secret, downloads images locally (Notion signed URLs expire ~1h),
 * and writes static blog.html + blog/<slug>.html. No token ever reaches the
 * browser or any committed file.
 *
 * Required env: NOTION_BLOG_TOKEN  (GitHub Actions secret)
 *
 * Run from the repo root:  node scripts/build-blog.mjs
 */

import { Client } from '@notionhq/client';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import https from 'node:https';

// ---------- config ----------
const DATABASE_ID = 'a0b67e45d9f54b25919a96615791ede1';
const ROOT = process.cwd();                 // repo root (where blog.html lives)
const BLOG_INDEX = path.join(ROOT, 'blog.html');
const POSTS_DIR = path.join(ROOT, 'blog');           // blog/<slug>.html
const ASSETS_DIR = path.join(ROOT, 'blog-assets');   // downloaded images
const SITE_ORIGIN = 'https://cermain.com';
const DEFAULT_OG_IMAGE = SITE_ORIGIN + '/blog-assets/beyond-the-split-default.png';

const token = process.env.NOTION_BLOG_TOKEN;
if (!token) {
  console.error('FATAL: NOTION_BLOG_TOKEN is not set. Add it as a GitHub Actions secret.');
  process.exit(1);
}
const notion = new Client({ auth: token });

// ---------- small utils ----------
const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const slugify = (s = '') =>
  String(s).toLowerCase().trim().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || 'post';

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function readingTime(blocks) {
  const words = blocks
    .map(b => (b._plain || ''))
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        return resolve(download(res.headers.location, dest));
      }
      if (res.statusCode !== 200) { file.close(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    }).on('error', err => { file.close(); reject(err); });
  });
}

// ---------- Notion property helpers ----------
const plain = (rich = []) => rich.map(r => r.plain_text).join('');

function prop(page, name) { return page.properties?.[name]; }
function getTitle(page) {
  const p = Object.values(page.properties).find(v => v.type === 'title');
  return p ? plain(p.title) : '';
}
function getRichText(page, name) { const p = prop(page, name); return p?.type === 'rich_text' ? plain(p.rich_text) : ''; }
function getCheckbox(page, name) { const p = prop(page, name); return p?.type === 'checkbox' ? p.checkbox : false; }
function getDate(page, name) { const p = prop(page, name); return p?.type === 'date' ? p.date?.start : null; }
function getSelect(page, name) { const p = prop(page, name); return p?.type === 'select' ? (p.select?.name || '') : ''; }
function getMulti(page, name) { const p = prop(page, name); return p?.type === 'multi_select' ? p.multi_select.map(o => o.name) : []; }
function getCover(page) {
  const c = page.cover;
  if (!c) return null;
  return c.type === 'external' ? c.external.url : c.file?.url || null;
}

// ---------- rich text → HTML ----------
function renderRich(rich = []) {
  return rich.map(r => {
    let t = esc(r.plain_text);
    const a = r.annotations || {};
    if (a.code) t = `<code>${t}</code>`;
    if (a.bold) t = `<strong>${t}</strong>`;
    if (a.italic) t = `<em>${t}</em>`;
    if (a.strikethrough) t = `<s>${t}</s>`;
    if (a.underline) t = `<u>${t}</u>`;
    if (r.href) t = `<a href="${esc(r.href)}" target="_blank" rel="noopener">${t}</a>`;
    return t;
  }).join('');
}

// ---------- block fetch (with image download) ----------
async function fetchBlocks(blockId) {
  const out = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 });
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function renderBlocks(blocks, slug) {
  // tag plain text for reading-time, then render
  let html = '';
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    const type = b.type;
    const data = b[type];
    b._plain = data?.rich_text ? plain(data.rich_text) : '';

    if (type === 'paragraph') {
      const inner = renderRich(data.rich_text);
      html += inner.trim() ? `<p>${inner}</p>\n` : '';
      i++;
    } else if (type === 'heading_1') {
      html += `<h2 class="post-h1">${renderRich(data.rich_text)}</h2>\n`; i++;
    } else if (type === 'heading_2') {
      html += `<h3 class="post-h2">${renderRich(data.rich_text)}</h3>\n`; i++;
    } else if (type === 'heading_3') {
      html += `<h4 class="post-h3">${renderRich(data.rich_text)}</h4>\n`; i++;
    } else if (type === 'bulleted_list_item' || type === 'numbered_list_item') {
      const tag = type === 'bulleted_list_item' ? 'ul' : 'ol';
      let items = '';
      while (i < blocks.length && blocks[i].type === type) {
        const d = blocks[i][type];
        blocks[i]._plain = plain(d.rich_text);
        items += `<li>${renderRich(d.rich_text)}</li>\n`;
        i++;
      }
      html += `<${tag} class="post-list">${items}</${tag}>\n`;
    } else if (type === 'quote') {
      html += `<blockquote class="post-quote">${renderRich(data.rich_text)}</blockquote>\n`; i++;
    } else if (type === 'divider') {
      html += `<hr class="post-divider">\n`; i++;
    } else if (type === 'code') {
      html += `<pre class="post-code"><code>${esc(plain(data.rich_text))}</code></pre>\n`; i++;
    } else if (type === 'image') {
      const url = data.type === 'external' ? data.external.url : data.file?.url;
      const caption = renderRich(data.caption || []);
      if (url) {
        const local = await saveImage(url, slug);
        html += `<figure class="post-figure"><img src="${esc(local)}" alt="${esc(plain(data.caption || []))}" loading="lazy">` +
          (caption ? `<figcaption>${caption}</figcaption>` : '') + `</figure>\n`;
      }
      i++;
    } else {
      // unsupported block types are skipped silently
      i++;
    }
  }
  return html;
}

let imgCounter = 0;
async function saveImage(url, slug) {
  const dir = path.join(ASSETS_DIR, slug);
  await fs.mkdir(dir, { recursive: true });
  const clean = url.split('?')[0];
  const ext = (clean.match(/\.(png|jpe?g|gif|webp|svg|avif)$/i) || [, 'png'])[1].toLowerCase();
  const name = `img-${++imgCounter}.${ext}`;
  const dest = path.join(dir, name);
  await download(url, dest);
  return `../blog-assets/${slug}/${name}`; // relative from blog/<slug>.html
}

// ---------- index list rendering ----------
function postCard(post, forIndex = true) {
  const streamClass = post.stream === 'personal' ? ' is-personal' : '';
  const catLabel = post.stream === 'personal' ? 'Personal' : 'Practice';
  const topics = post.topics.map(t => `<span class="post-topic">${esc(t)}</span>`).join('');
  return `      <a class="post${streamClass} reveal" data-stream="${post.stream}" href="blog/${post.slug}.html">
        <div class="post-top">
          <span class="post-cat">${esc(catLabel)}</span>
          <span class="post-date">${esc(post.dateLabel)}</span>
          <span class="post-rt">${post.readingTime} min read</span>
        </div>
        <h3>${esc(post.title)}</h3>
        ${post.excerpt ? `<p>${esc(post.excerpt)}</p>` : ''}
        ${topics ? `<div class="post-topics">${topics}</div>` : ''}
        <span class="more">Read →</span>
      </a>`;
}

// ---------- shell extraction from blog.html ----------
function extractShell(blogHtml) {
  const headEnd = blogHtml.indexOf('</head>');
  let head = blogHtml.slice(0, headEnd) + '</head>';
  // inject post-specific styles once
  head = head.replace('</head>', POST_STYLES + '\n</head>');
  // rewrite relative nav links for /blog/ subdir
  head = head.replace(/href="(index|founding|fundraising|esop-framework|esop-roadmap|experience|blog)\.html"/g, 'href="../$1.html"');

  const bodyOpen = blogHtml.indexOf('<body>');
  const mainOpen = blogHtml.indexOf('<main>', bodyOpen);
  // chrome = everything between <body> and <main>
  const chrome = blogHtml.slice(bodyOpen + '<body>'.length, mainOpen)
    .replace(/href="(index|founding|fundraising|esop-framework|esop-roadmap|experience|blog)\.html"/g, 'href="../$1.html"');

  const mainClose = blogHtml.indexOf('</main>');
  const footer = blogHtml.slice(mainClose + '</main>'.length); // includes footer + scripts + </body></html>

  // head for posts also carries the chrome right after <body>
  const shellHead = head;            // up to and including </head>
  const shellFoot = footer;          // </main> already consumed; footer onwards
  return { shellHead, chrome, shellFoot };
}

const POST_STYLES = `<style id="post-article-css">
  .post-article{ padding:64px 32px 40px; }
  .post-article-inner{ max-width:680px; margin:0 auto; }
  .post-article .back-overview{ margin-bottom:26px; }
  .post-article-top{ display:flex; gap:14px; align-items:center; font-size:11.5px; letter-spacing:.08em; text-transform:uppercase; font-weight:600; color:var(--muted); }
  .post-article-top .post-cat{ color:var(--sage-deep); display:inline-flex; align-items:center; gap:7px; }
  .post-article-top .post-cat::before{ content:""; width:6px; height:6px; border-radius:50%; background:var(--sage); }
  .post-article-title{ font-family:'Lora',Georgia,serif; font-weight:400; font-size:clamp(32px,4.4vw,52px); line-height:1.08; letter-spacing:-.02em; color:var(--navy); margin:14px 0 0; }
  .post-article-standfirst{ font-size:20px; line-height:1.5; color:var(--muted); margin-top:18px; font-weight:300; }
  .post-body{ margin-top:34px; font-size:18px; line-height:1.72; color:var(--ink); }
  .post-body > * + *{ margin-top:22px; }
  .post-body p{ max-width:68ch; }
  .post-h1{ font-family:'Lora',Georgia,serif; font-weight:500; font-size:30px; color:var(--navy); letter-spacing:-.01em; margin-top:46px; line-height:1.2; }
  .post-h2{ font-family:'Lora',Georgia,serif; font-weight:500; font-size:24px; color:var(--navy); margin-top:38px; line-height:1.25; }
  .post-h3{ font-weight:700; font-size:18px; color:var(--navy); margin-top:30px; letter-spacing:.01em; }
  .post-list{ padding-left:24px; max-width:66ch; }
  .post-list li{ margin:8px 0; }
  .post-quote{ border-left:2px solid var(--sage); padding:6px 0 6px 24px; font-family:'Lora',Georgia,serif; font-style:italic; font-size:22px; line-height:1.45; color:var(--navy); max-width:60ch; }
  .post-divider{ border:none; border-top:1px solid var(--rule); width:54px; margin:40px 0; }
  .post-code{ background:var(--cream-warm); border:1px solid var(--rule); border-radius:8px; padding:16px 18px; overflow:auto; font-size:14px; line-height:1.6; }
  .post-figure{ margin:30px 0; }
  .post-figure img{ width:100%; height:auto; border-radius:10px; display:block; }
  .post-figure figcaption{ font-size:13px; color:var(--muted); margin-top:10px; text-align:center; }
  .post-foot-embed{ margin-top:56px; padding-top:34px; border-top:1px solid var(--rule); text-align:center; }
  .post-foot-embed .post-foot-k{ font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--sage-deep); font-weight:600; margin-bottom:18px; }
  :lang(zh-hant) .post-article-title,:lang(zh-hans) .post-article-title,:lang(zh-hant) .post-h1,:lang(zh-hans) .post-h1,:lang(zh-hant) .post-h2,:lang(zh-hans) .post-h2{ font-family:'Noto Serif TC','Noto Serif SC','Lora',serif; }
</style>`;

// ---------- main ----------
async function main() {
  console.log('› Querying Notion database…');
  const pages = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: { property: 'Published', checkbox: { equals: true } },
      sorts: [{ property: 'Date', direction: 'descending' }],
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  console.log(`  found ${pages.length} published post(s).`);

  await fs.mkdir(POSTS_DIR, { recursive: true });
  await fs.mkdir(ASSETS_DIR, { recursive: true });

  const posts = [];
  for (const page of pages) {
    const title = getTitle(page) || 'Untitled';
    const slug = getRichText(page, 'Slug') || slugify(title);
    const channel = (getSelect(page, 'Channel') || 'Practice').toLowerCase();
    const stream = channel === 'mirror' || channel === 'personal' ? 'personal' : 'practice';
    const dateIso = getDate(page, 'Date') || page.created_time;
    const excerpt = getRichText(page, 'Excerpt');
    const topics = getMulti(page, 'Topics');

    console.log(`  · ${title}  [${stream}]  /blog/${slug}.html`);
    const blocks = await fetchBlocks(page.id);
    const bodyHtml = await renderBlocks(blocks, slug);

    // cover → local og image
    let ogImage = null;
    const cover = getCover(page);
    if (cover) {
      const local = await saveImage(cover, slug);
      ogImage = SITE_ORIGIN + '/' + local.replace('../', '');
    }

    posts.push({
      title, slug, stream, excerpt, topics,
      dateIso, dateLabel: fmtDate(dateIso),
      readingTime: readingTime(blocks),
      bodyHtml, ogImage,
    });
  }

  // ----- index injection -----
  const blogHtml = await fs.readFile(BLOG_INDEX, 'utf8');
  const { shellHead, chrome, shellFoot } = extractShell(blogHtml);

  let listHtml;
  if (!posts.length) {
    listHtml = `    <div class="blog-empty reveal">
      <span class="blog-empty-mark" aria-hidden="true">✎</span>
      <p class="blog-empty-title">First pieces coming soon.</p>
      <p class="blog-empty-sub">Short, practical notes — written from the company and founder side.</p>
    </div>`;
  } else {
    listHtml = posts.map(p => postCard(p)).join('\n') +
      `\n      <p class="stream-empty" hidden>Nothing in this stream yet.</p>`;
  }

  const injected = blogHtml.replace(
    /<!-- BLOG_POSTS_START -->[\s\S]*?<!-- BLOG_POSTS_END -->/,
    `<!-- BLOG_POSTS_START -->\n${listHtml}\n    <!-- BLOG_POSTS_END -->`
  );
  await fs.writeFile(BLOG_INDEX, injected, 'utf8');
  console.log('› Wrote blog.html');

  // ----- per-post pages -----
  for (const p of posts) {
    const page = buildPostPage(shellHead, chrome, shellFoot, p);
    await fs.writeFile(path.join(POSTS_DIR, p.slug + '.html'), page, 'utf8');
  }
  if (posts.length) console.log(`› Wrote ${posts.length} post page(s) to /blog/`);

  console.log('✓ Done.');
}

// ---------- per-post page (reuses blog.html shell) ----------
function buildPostPage(shellHead, chrome, shellFoot, post) {
  // shellHead (head, nav rewritten to ../) + chrome (nav bar) + article + shellFoot (footer+scripts)
  const topics = post.topics.map(t => `<span class="post-topic">${esc(t)}</span>`).join('');
  const ogImage = post.ogImage || DEFAULT_OG_IMAGE;
  const head = shellHead
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(post.title)} — Cermain Cheung</title>`)
    .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${esc(post.excerpt)}">`)
    .replace(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${esc(post.title)}">`)
    .replace(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${esc(post.excerpt)}">`)
    .replace('</head>', `<meta property="og:image" content="${esc(ogImage)}">\n</head>`);

  const article = `<main>
<article class="post-article">
  <div class="post-article-inner">
    <a class="back-overview" href="../blog.html">← Back to Blog</a>
    <div class="post-article-top">
      <span class="post-cat">${post.stream === 'personal' ? 'Personal' : 'Practice'}</span>
      <span class="post-date">${esc(post.dateLabel)}</span>
      <span class="post-rt">${post.readingTime} min read</span>
    </div>
    <h1 class="post-article-title">${esc(post.title)}</h1>
    ${post.excerpt ? `<p class="post-article-standfirst">${esc(post.excerpt)}</p>` : ''}
    ${topics ? `<div class="post-topics">${topics}</div>` : ''}
    <div class="post-body">
${post.bodyHtml}
    </div>
    <div class="post-foot-embed">
      <p class="post-foot-k">Beyond the Split — the newsletter</p>
      <script async src="https://subscribe-forms.beehiiv.com/v3/loader.js" data-beehiiv-form="0b8f9996-27d7-4510-b317-9e8ec5cec36a"></script>
    </div>
  </div>
</article>
</main>`;

  return head + '\n<body>\n' + chrome + '\n' + article + '\n' + shellFoot;
}
main().catch(err => { console.error(err); process.exit(1); });
