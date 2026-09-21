/*
  headers.ts — writes the one response header that cannot be maintained by hand.

  Run:  node scripts/headers.ts   (npm run build does it last, after the pages
                                   are final — the header describes them)

  Everything in www/_headers is written by a person except one line: the Content
  Security Policy. It lists what a page may load and from where, and anything
  not on the list does not load at all. That is the whole defence: a script
  smuggled into the markup — through a car description in the database, say —
  has nowhere to be fetched from and no hash to match, so the browser refuses to
  run it.

  Why a script rather than a hand-written line. Two scripts on this site sit
  inside the HTML instead of a file, because both must run before the first
  paint: the theme switch in blocks/head.html and the language redirect in
  www/index.html. An inline script is allowed only by the hash of its exact
  text, down to the last space — and that hash changes the moment either script
  is edited. Left to a person, the line would fall out of step on the first
  edit, and it would do so silently: server.ts sends no headers, so the site
  keeps working at the desk and breaks only once it is live.

  What is deliberately NOT hashed: <script type="application/ld+json">. A script
  with a type the browser does not execute is a data block, never runs, and is
  therefore never weighed against script-src. Hashing all thirty of them would
  make a header several kilobytes long for no gain.
*/

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { ROOT, fail, readData, type Values } from "../lib/site.ts";

const SITE_DIR = join(ROOT, "www");
const HEADERS = join(SITE_DIR, "_headers");

// The generated line lives between these two, and nothing else does.
const OPEN = "  # @csp";
const CLOSE = "  # @";

/** Every .html inside www, all the way down through every folder. */
function pages(dir: string = SITE_DIR): string[] {
  const found: string[] = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) found.push(...pages(path));
    else if (item.name.endsWith(".html")) found.push(path);
  }
  return found;
}

// A script the browser runs: no src (a file is covered by 'self'), no type.
const INLINE = /<script(?![^>]*\s(?:src|type)=)[^>]*>([\s\S]*?)<\/script>/g;

/** One 'sha256-…' per distinct inline script on the site, in a stable order so
    an unchanged site produces an unchanged file. */
function inlineHashes(): string[] {
  const seen = new Set<string>();
  for (const path of pages()) {
    for (const [, body] of readFileSync(path, "utf8").matchAll(INLINE))
      seen.add("'sha256-" + createHash("sha256").update(body, "utf8").digest("base64") + "'");
  }
  return [...seen].sort();
}

function policy(data: Values, hashes: string[]): string {
  // The photos are the only thing the site loads from anywhere else.
  const photos = (data["photos-origin"] ?? "").replace(/\/+$/, "");
  if (!photos) fail("data.txt has no photos-origin — the policy would block every car photo");

  return [
    // Nothing is allowed from anywhere unless a line below says otherwise.
    "default-src 'self'",
    `img-src 'self' ${photos}`,
    `script-src 'self' ${hashes.join(" ")}`,
    // No <style> block and no style="…" anywhere on the site — checked, and if
    // one ever appears this line is what will point it out.
    "style-src 'self'",
    "font-src 'self'",
    // Nothing on the site calls anywhere: the database is read at build time,
    // by these scripts, not by the browser.
    "connect-src 'self'",
    // A <base> tag could quietly re-point every relative link on the page.
    "base-uri 'self'",
    "form-action 'self'",
    // The site is not to be shown inside somebody else's frame.
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

function main(): void {
  const hashes = inlineHashes();
  const before = readFileSync(HEADERS, "utf8");

  const open = before.indexOf(OPEN + "\n");
  const close = before.indexOf(CLOSE + "\n", open);
  if (open === -1 || close === -1)
    fail(`${relative(ROOT, HEADERS)}: the "${OPEN.trim()} … ${CLOSE.trim()}" markers are gone — ` +
         "without them there is nowhere to write the policy");

  const line = `  Content-Security-Policy: ${policy(readData(), hashes)}\n`;
  const after = before.slice(0, open + OPEN.length + 1) + line + before.slice(close);

  if (after === before) {
    console.log(`CSP: unchanged, ${hashes.length} inline script(s) allowed by hash`);
    return;
  }
  writeFileSync(HEADERS, after, "utf8");
  console.log(`CSP: rewritten, ${hashes.length} inline script(s) allowed by hash`);
}

main();
