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

  The modification date comes from the filesystem: whenever the page was last
  written is when the builder last rewrote it.
*/

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, readData, fail } from "../lib/site.ts";

const WWW = join(ROOT, "www");

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

function main(): void {
  const data = readData();
  const domain = data["domain"].replace(/\/+$/, "");
  if (!/^https?:\/\//.test(domain))
    fail(`the domain key in data.txt must start with https:// — right now it is "${domain}"`);

  const open: string[] = [];
  let hidden = 0;
  for (const path of pages(WWW).sort()) {
    if (readFileSync(path, "utf8").includes('name="robots" content="noindex"')) { hidden++; continue; }
    const when = statSync(path).mtime.toISOString().slice(0, 10);
    open.push(`  <url>\n    <loc>${domain}${address(path)}</loc>\n` +
              `    <lastmod>${when}</lastmod>\n  </url>`);
  }

  writeFileSync(join(WWW, "sitemap.xml"),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    open.join("\n") + "\n</urlset>\n", "utf8");

  writeFileSync(join(WWW, "robots.txt"),
    "User-agent: *\nAllow: /\n\n" + `Sitemap: ${domain}/sitemap.xml\n`, "utf8");

  console.log(`Sitemap: ${open.length} pages, ${hidden} hidden from search`);
  console.log(`robots.txt: points at ${domain}/sitemap.xml`);
}

main();
