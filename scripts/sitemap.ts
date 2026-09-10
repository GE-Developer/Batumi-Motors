/*
  sitemap.ts — the sitemap and robots.txt.

  Run:      node scripts/sitemap.ts
  Usually:  it is the last step of `npm run build`.

  Why last. Car pages are created and removed by car-pages.ts: take a car out of
  the database and its page disappears from disk. The map is built by walking the
  finished www folder rather than from a list in someone's head, so it always
  matches what is actually on the site.

  What does NOT go into the map: pages marked noindex. That is "not found" in
  three languages plus the root file, which only detects the browser language and
  sends the visitor on. There is no point offering those to search — they are
  closed off anyway.

  Where lastmod comes from. NOT from the filesystem. A build host starts from a
  fresh clone of the repository, so every file there is created at the same
  moment — and with mtime, all 45 pages would be stamped "changed today" on every
  single build. Google's own guidance is that an inaccurate lastmod gets the
  whole signal ignored, so that would be worse than having no dates at all.

  Instead we remember, in sitemap-dates.json, what each page looked like and when
  it last actually changed. On every run a page's content is hashed and compared:
  the same hash keeps the old date, a different hash gets today's. That file
  belongs in the repository — it is the site's memory of its own dates, and
  without it every page looks new again.
*/

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { ROOT, readData, fail } from "../lib/site.ts";

const WWW = join(ROOT, "www");
const DATES_FILE = join(ROOT, "sitemap-dates.json");

/** What a page looked like last time, and the day it changed. */
type Stamp = { hash: string; date: string };

/** Every .html inside www, all the way down through every folder. */
function pages(dir: string): string[] {
  const found: string[] = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) found.push(...pages(path));
    else if (item.name.endsWith(".html")) found.push(path);
  }
  return found;
}

/** A page's address on the site: www/ru/cars/index.html → /ru/cars/ */
function address(path: string): string {
  const tail = relative(WWW, path).split("\\").join("/");
  return "/" + tail.replace(/index\.html$/, "");
}

/** The remembered dates. A missing or malformed file is not a reason to stop:
    we simply start remembering from scratch, and every page gets today. Losing
    the dates costs one imprecise sitemap; stopping the build costs the deploy. */
function readStamps(): Record<string, Stamp> {
  if (!existsSync(DATES_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(DATES_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    console.log("  ⚠ sitemap-dates.json could not be read — starting the dates afresh");
    return {};
  }
}

function main(): void {
  const data = readData();
  const domain = data["domain"].replace(/\/+$/, "");
  if (!/^https?:\/\//.test(domain))
    fail(`the domain key in data.txt must start with https:// — right now it is "${domain}"`);

  const known = readStamps();
  const stamps: Record<string, Stamp> = {};
  const today = new Date().toISOString().slice(0, 10);

  const open: string[] = [];
  let hidden = 0;
  let moved = 0;
  for (const path of pages(WWW).sort()) {
    const html = readFileSync(path, "utf8");
    if (html.includes('name="robots" content="noindex"')) { hidden++; continue; }

    const url = address(path);
    const hash = createHash("sha256").update(html).digest("hex");
    const prior = known[url];
    // Same bytes as last time — the page did not change, so neither does its
    // date. Different bytes, or a page we have never seen: today.
    const changed = !prior || prior.hash !== hash;
    const when = changed ? today : prior.date;
    if (changed) moved++;

    stamps[url] = { hash, date: when };
    open.push(`  <url>\n    <loc>${domain}${url}</loc>\n` +
              `    <lastmod>${when}</lastmod>\n  </url>`);
  }

  writeFileSync(join(WWW, "sitemap.xml"),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    open.join("\n") + "\n</urlset>\n", "utf8");

  writeFileSync(join(WWW, "robots.txt"),
    "User-agent: *\nAllow: /\n\n" + `Sitemap: ${domain}/sitemap.xml\n`, "utf8");

  // Written every run, but the content only moves for pages that really changed —
  // so an unchanged site produces no diff here either.
  writeFileSync(DATES_FILE, JSON.stringify(stamps, null, 2) + "\n", "utf8");

  console.log(`Sitemap: ${open.length} pages, ${hidden} hidden from search`);
  console.log(moved
    ? `Dates moved to ${today}: ${moved} page(s), the rest kept theirs`
    : "Dates: nothing changed, every page kept its own");
  console.log(`robots.txt: points at ${domain}/sitemap.xml`);
}

main();
