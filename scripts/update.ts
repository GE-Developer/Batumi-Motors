/*
  update.ts — distributes the shared text and the shared chunks of markup across
  every page, in all three languages.

  What lives where
      data.txt     values that are the same in every language: phone, domain, name
      text/ru.txt  translatable text: menu, captions, buttons
      text/en.txt
      text/ka.txt
      blocks/      chunks of markup that appear on every page
      www/         the site itself: Russian in ru/, English in en/, Georgian in ka/

  The pages stay ordinary HTML. The script only edits what sits between markers:

      <!--#footer-->
        ...it puts blocks/footer.html here...
      <!--#-->

  It does not touch anything else on the page — that is your text, and it is safe.

  What the script does on its own, without your involvement
      • puts the language into <html lang="…">
      • builds canonical and hreflang — how Google understands that the three
        versions of a page are the same thing
      • builds the RU / EN / KA switcher, pointing at THIS SAME page in the other
        language rather than at the home page
      • highlights the menu item of the current section
      • fixes up the phone number and WhatsApp everywhere they appear

  Run:   node update.ts
*/

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep, basename } from "node:path";
import { substitute, publicData, jsonLd } from "../lib/site.ts";

const ROOT = join(import.meta.dirname, "..");
const DATA_FILE = join(ROOT, "data.txt");
const TEXT_DIR = join(ROOT, "text");
const BLOCKS_DIR = join(ROOT, "blocks");
const SITE_DIR = join(ROOT, "www");

// The site's languages. Each has its own folder, Russian included: www/ru/,
// www/en/, www/ka/. The root of www/ holds only index.html — it forwards to a
// language.
const LANGS = ["ru", "en", "ka"] as const;
type Lang = (typeof LANGS)[number];

// Where to send someone whose language we do not know.
const X_DEFAULT: Lang = "en";

// The site's sections. Section name = folder name = the nav-<name> key in text/*.txt
const SECTIONS = ["cars", "deals", "terms", "about"];

// A marker takes up a whole line, so we search line by line.
// Groups: 1 — indentation, 2 — block name, 3 — optional parameter.
const MARKER = /^([ \t]*)<!--#([^\s>]+)(?:[ \t]+([^>]*?))?[ \t]*-->\n[\s\S]*?^[ \t]*<!--#-->[ \t]*$/gm;

// Substitution of the form {key}. Lowercase Latin letters, digits and hyphens
// only — so it cannot be confused with curly braces inside JavaScript.
const PLACEHOLDER = /\{([a-z0-9-]+)\}/g;
const KEY_OK = /^[a-z0-9-]+$/;

const REQUIRED_DATA = ["domain", "phone", "phone-link", "whatsapp"];

// Which font files to preload on each language's pages.
// Latin is needed everywhere — the name Batumi Motors is set in it.
const FONT_PRELOAD: Record<Lang, string[]> = {
  ru: ["nunito-latin", "nunito-cyrillic"],
  en: ["nunito-latin"],
  ka: ["nunito-latin", "noto-georgian"],
};

type Values = Record<string, string>;

function fail(message: string): never {
  console.error("✖ " + message);
  process.exit(1);
}

/** A "key = value" file into a dictionary. */
function readPairs(path: string): Values {
  const values: Values = {};
  const name = basename(path);
  readFileSync(path, "utf8").split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const number = index + 1;
    if (!line.includes("=")) throw new Error(`${name}, line ${number}: no "=" sign — "${line}"`);
    const key = line.slice(0, line.indexOf("=")).trim();
    const value = line.slice(line.indexOf("=") + 1).trim();
    if (!KEY_OK.test(key))
      throw new Error(`${name}, line ${number}: the key "${key}" has characters it should not. ` +
           "Lowercase Latin letters, digits and hyphens are allowed");
    if (key in values) throw new Error(`${name}, line ${number}: the key "${key}" is written twice`);
    values[key] = value;
  });
  return values;
}

function readData(): Values {
  if (!existsSync(DATA_FILE)) throw new Error("could not find data.txt next to the script");
  const values = readPairs(DATA_FILE);
  for (const key of REQUIRED_DATA)
    if (!(key in values)) throw new Error(`data.txt is missing the required key "${key}"`);
  return values;
}

/** text/*.txt by language. The key sets must match across all three. */
function readTexts(): Record<Lang, Values> {
  const texts = {} as Record<Lang, Values>;
  for (const lang of LANGS) {
    const path = join(TEXT_DIR, `${lang}.txt`);
    if (!existsSync(path)) throw new Error(`could not find text/${lang}.txt`);
    texts[lang] = readPairs(path);
  }

  const baseline = Object.keys(texts.ru);
  for (const lang of LANGS) {
    const own = Object.keys(texts[lang]);
    const missing = baseline.filter((k) => !own.includes(k)).sort();
    const extra = own.filter((k) => !baseline.includes(k)).sort();
    if (missing.length)
      throw new Error(`text/${lang}.txt is missing keys that ru has: ` + missing.join(", "));
    if (extra.length)
      throw new Error(`text/${lang}.txt has extra keys that ru does not: ` + extra.join(", "));
  }

  for (const section of SECTIONS)
    if (!baseline.includes(`nav-${section}`))
      throw new Error(`text/ru.txt has no "nav-${section}" key for the ${section} section`);
  return texts;
}

function readBlocks(): Values {
  if (!existsSync(BLOCKS_DIR) || !statSync(BLOCKS_DIR).isDirectory())
    throw new Error("could not find the blocks/ folder");
  const blocks: Values = {};
  for (const file of readdirSync(BLOCKS_DIR).sort())
    if (file.endsWith(".html"))
      blocks[file.slice(0, -5)] = readFileSync(join(BLOCKS_DIR, file), "utf8").replace(/\n+$/, "");
  return blocks;
}

/** Every .html inside www/, in a stable order. */
function pages(): string[] {
  return readdirSync(SITE_DIR, { recursive: true, encoding: "utf8" })
    .filter((p) => p.endsWith(".html"))
    .sort()
    .map((p) => join(SITE_DIR, p));
}

/** File path → [language, page key], or null if the file is not a language page.

    www/ru/cars/index.html     → ["ru", "cars/"]
    www/ka/404.html            → ["ka", "404.html"]
    www/index.html             → null — that is the redirect, we leave it alone
*/
function classify(path: string): [Lang, string] | null {
  let parts = relative(SITE_DIR, path).split(sep);
  if (!parts.length || !LANGS.includes(parts[0] as Lang)) return null;
  const lang = parts[0] as Lang;
  parts = parts.slice(1);

  if (parts.length && parts[parts.length - 1] === "index.html") {
    parts = parts.slice(0, -1);
    return [lang, parts.length ? parts.join("/") + "/" : ""];
  }
  return [lang, parts.join("/")];
}

/** A page's address on the site: /ru/cars/ , /en/cars/ , /ka/cars/ */
function url(lang: Lang, key: string): string {
  return "/" + lang + "/" + key;
}

/** canonical + hreflang. Error pages are taken out of the index. */
function buildAlternates(key: string, lang: Lang, domain: string, indent = "  "): string {
  if (key === "404.html") return indent + '<meta name="robots" content="noindex">';
  const d = domain.replace(/\/+$/, "");
  const lines = [`${indent}<link rel="canonical" href="${d}${url(lang, key)}">`];
  for (const other of LANGS)
    lines.push(`${indent}<link rel="alternate" hreflang="${other}" href="${d}${url(other, key)}">`);
  lines.push(`${indent}<link rel="alternate" hreflang="x-default" href="${d}${url(X_DEFAULT, key)}">`);
  return lines.join("\n");
}

/** Preview tags for messengers and social networks.

    The title and description are NOT invented: they are taken from the page
    itself, where they are already written and checked. So every car gets its own
    preview rather than one shared across the site. Error pages are skipped —
    nobody shares those.

    An image is added only when data.txt has an og-image key. Without it the
    preview still works: the messenger shows the name and the description. The
    key may hold a full address or a path from the root of the site; a path is
    joined to the domain here, because a messenger fetches the picture from its
    own servers and a relative address means nothing to it. */
function buildOpenGraph(html: string, key: string, lang: Lang, data: Values,
                        indent = "  "): string {
  if (key === "404.html") return "";
  const pick = (re: RegExp) => (html.match(re)?.[1] ?? "").trim();
  const title = pick(/<title>([^<]*)<\/title>/);
  const description = pick(/<meta name="description" content="([^"]*)"/);
  const domain = data["domain"].replace(/\/+$/, "");
  const locale = { ru: "ru_RU", en: "en_GB", ka: "ka_GE" }[lang];
  const site = `${data["brand-1"]} ${data["brand-2"]}`;

  const tags = [
    ["og:type", "website"],
    ["og:site_name", site],
    ["og:locale", locale],
    ["og:url", domain + url(lang, key)],
    ["og:title", title],
    ["og:description", description],
  ];
  const image = data["og-image"];
  if (image) {
    tags.push(["og:image", image.startsWith("/") ? domain + image : image]);
    // Stated outright so the messenger can lay out the card before the picture
    // has finished downloading, instead of reflowing the message once it lands.
    tags.push(["og:image:width", "1200"], ["og:image:height", "630"]);
  }

  const lines = tags.map(([k, v]) => `${indent}<meta property="${k}" content="${v}">`);
  lines.push(`${indent}<meta name="twitter:card" content="` +
             (image ? "summary_large_image" : "summary") + `">`);
  return lines.join("\n");
}

/** Structured data for the home page: who this business is, in the form a
    search engine reads instead of guessing from the words on the page.

    AutoRental is schema.org's own type for car hire — narrower than
    LocalBusiness and understood as such. Only the home page carries it: repeat
    the same business on all forty-five pages and a search engine has to work
    out which one is the real description. Car pages describe the CAR instead,
    and that is built in car-pages.ts, where the car's data actually is.

    No street address is claimed here, because the site does not state one. The
    city and the country are true and enough to be placed on the map of Batumi;
    inventing a street to fill the field would be worse than leaving it out. */
function buildStructuredData(key: string, lang: Lang, data: Values, indent = "  "): string {
  if (key !== "") return "";
  const domain = data["domain"].replace(/\/+$/, "");
  return jsonLd({
    "@context": "https://schema.org",
    "@type": "AutoRental",
    "@id": domain + "/#business",
    name: `${data["brand-1"]} ${data["brand-2"]}`,
    url: domain + url(lang, key),
    image: domain + "/og.png",
    telephone: data["phone-link"],
    address: { "@type": "PostalAddress", addressLocality: "Batumi", addressCountry: "GE" },
    areaServed: { "@type": "City", name: "Batumi" },
    sameAs: [`https://www.instagram.com/${data["instagram"]}`],
  }, indent);
}

function buildFontPreload(lang: Lang, indent = "  "): string {
  return FONT_PRELOAD[lang]
    .map((name) => `${indent}<link rel="preload" href="/assets/fonts/${name}.woff2" ` +
                   `as="font" type="font/woff2" crossorigin>`)
    .join("\n");
}

/** Highlights the current language in the switcher. */
function markLang(block: string, ownUrl: string, page: string): string {
  const plain = `class="lang__link" href="${ownUrl}"`;
  if (!block.includes(plain))
    fail(`${page}: could not find a link to the current language in blocks/header.html. ` +
         "Check that the switcher has {url-ru}, {url-en} and {url-ka}");
  return block.split(plain).join(
    `class="lang__link is-active" href="${ownUrl}" aria-current="true"`);
}

function markActive(header: string, href: string): string {
  const plain = `class="nav__link" href="${href}"`;
  if (!header.includes(plain)) fail(`blocks/header.html has no menu item with the address "${href}"`);
  return header.split(plain).join(`class="nav__link is-active" href="${href}"`);
}

function insertBlocks(page: string, blocks: Values, values: Values,
                      lang: Lang, key: string, name: string): string {
  return page.replace(MARKER, (_full, indent: string, block: string, param?: string) => {
    if (!(block in blocks))
      fail(`${name}: marker <!--#${block}-->, but there is no blocks/${block}.html file`);

    let body = substitute(blocks[block], values);
    if (body.includes('class="lang__link"')) body = markLang(body, url(lang, key), name);
    let opening = `${indent}<!--#${block}-->`;

    if (param && param.trim()) {
      const section = param.trim();
      if (!SECTIONS.includes(section))
        fail(`${name}: marker <!--#${block} ${section}--> — there is no such section. ` +
             "Sections: " + SECTIONS.join(", "));
      body = markActive(body, url(lang, section + "/"));
      opening = `${indent}<!--#${block} ${section}-->`;
    }

    const leftover = [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]))].sort();
    if (leftover.length)
      fail(`${name}, block ${block}: unknown substitutions — ` +
           leftover.map((k) => "{" + k + "}").join(", "));

    return `${opening}\n${body}\n${indent}<!--#-->`;
  });
}

function fixPageLang(page: string, lang: Lang): string {
  return page.replace(/(<html[^>]*\blang=")[^"]*(")/, (_m, a: string, b: string) => a + lang + b);
}

/** Phone and WhatsApp — everywhere, not only inside blocks. */
function fixContacts(page: string, data: Values): string {
  page = page.replace(/href="tel:[^"]*"/g, `href="tel:${data["phone-link"]}"`);
  page = page.replace(/(<a[^>]*href="tel:[^"]*"[^>]*>)[^<]*(<\/a>)/g,
                      (_m, a: string, b: string) => a + data["phone"] + b);
  page = page.replace(/https:\/\/wa\.me\/\d+/g, `https://wa.me/${data["whatsapp"]}`);
  return page;
}

/** Stamp every stylesheet and script link with a version taken from the file's
    own contents: /assets/css/style.css?v=3f9c2a1b04.

    This exists so the files can be cached hard. Their names never change, so
    without a version a long cache is a trap: edit the stylesheet and everyone who
    has already been on the site keeps the old one until their cache expires. With
    the hash in the link, an edit changes the address, the browser sees a file it
    has never fetched, and takes the new one immediately — while an unchanged file
    keeps its address and is never asked for again.

    The whole page is scanned, not just the blocks: the stylesheet link sits in
    blocks/head.html, but the three script tags sit directly in each page's markup,
    outside any marker. Same reasoning as fixContacts() above.

    An existing ?v=… is replaced rather than appended to, so running this twice
    does not stack versions. A file that is linked but missing from disk keeps a
    bare link — a broken path should look broken, not carry a confident version. */
const ASSET_LINK = /\/assets\/(?:css|js)\/[a-z0-9-]+\.(?:css|js)(?:\?v=[a-f0-9]+)?/g;

function assetVersion(webPath: string): string | null {
  const disk = join(SITE_DIR, webPath.replace(/^\//, ""));
  if (!existsSync(disk)) return null;
  return createHash("sha256").update(readFileSync(disk)).digest("hex").slice(0, 10);
}

function fixAssetVersions(page: string): string {
  return page.replace(ASSET_LINK, (full) => {
    const bare = full.split("?")[0];
    const version = assetVersion(bare);
    return version ? `${bare}?v=${version}` : bare;
  });
}

/*
  loadContext() / fillBlocks() / applyToFile() — pulled out of main() so that
  car-pages.ts can do the same thing: it assembles a car page entirely in memory
  (template → substitutions → fillBlocks), compares it with what is already on
  disk, and writes only when they differ. After this, the order in which
  update.ts and car-pages.ts run stops mattering: car-pages.ts does not depend on
  whether update.ts has been run — the mere fact that it calls fillBlocks()
  guarantees a car page is never without its header and footer for a second, no
  matter who runs update.ts or when.

  The trap this avoids: if the page were first written out as a whole file and
  the #-markers were then filled in on a second pass over the file already on
  disk, every repeat run would find that the freshly assembled skeleton does not
  match what is on disk (which already carries last run's header and footer), and
  car-pages.ts would report "30 updated" forever, even with nothing changed.
*/

export type BlocksContext = { data: Values; texts: Record<Lang, Values>; blocks: Values };

/** Read everything the #-markers are assembled from. Throws Error on a malformed
    data.txt or text/*.txt rather than killing the process: this is used not only
    by a one-off run but also by the watcher in server.ts, via car-pages.ts. */
export function loadContext(): BlocksContext {
  return { data: readData(), texts: readTexts(), blocks: readBlocks() };
}

/** Fill the #-markers in a finished HTML string. Reads and writes nothing on
    disk — text only. path is needed to work out the page's language and key
    (classify()); for a page outside www/<lang>/… (www/index.html, say) it
    returns the html as it is — not our business.

    First a general substitute() pass: the same one used on blocks/*.html. For
    the eighteen hand-written pages it is a no-op (they hold no bare {tokens}
    outside markers), and the car-pages.ts template needs it (templates/car.html,
    where {url-cars}, {nav-cars} and the like sit right in the markup, not under
    a marker) — one substitution mechanism for the whole project, not two similar
    ones. */
export function fillBlocks(html: string, path: string, ctx: BlocksContext,
                          extra: Values = {}): string {
  const parsed = classify(path);
  if (!parsed) return html;
  const [lang, key] = parsed;
  const name = relative(ROOT, path);

  const values: Values = { ...publicData(ctx.data), ...ctx.texts[lang] };
  values["url-home"] = url(lang, "");
  for (const section of SECTIONS) values[`url-${section}`] = url(lang, section + "/");
  for (const other of LANGS) values[`url-${other}`] = url(other, key);
  values["alternates"] = buildAlternates(key, lang, ctx.data["domain"]);
  values["og"] = buildOpenGraph(html, key, lang, ctx.data);
  values["fontpreload"] = buildFontPreload(lang);
  values["jsonld"] = buildStructuredData(key, lang, ctx.data);
  // Last, so a page that knows better about itself wins: a car page hands over
  // its own {jsonld}, describing the car rather than the business.
  Object.assign(values, extra);

  let after = substitute(html, values);
  after = insertBlocks(after, ctx.blocks, values, lang, key, name);
  after = fixPageLang(after, lang);
  after = fixContacts(after, ctx.data);
  after = fixAssetVersions(after);
  return after;
}

/** Fill the #-markers in ONE file on disk. true means the file really changed.
    Reads the file, calls fillBlocks(), writes only on a difference — which is
    what main() below uses for the eighteen hand-written pages. */
export function applyToFile(path: string, ctx: BlocksContext): boolean {
  const before = readFileSync(path, "utf8");
  const after = fillBlocks(before, path, ctx);
  if (after === before) return false;
  writeFileSync(path, after, "utf8");
  return true;
}

function main(): void {
  if (!existsSync(SITE_DIR) || !statSync(SITE_DIR).isDirectory()) fail("could not find the www/ folder");

  // A one-off run is right to stop and name the reason — that is what fail() is
  // for. readData()/readTexts()/readBlocks() themselves throw Error rather than
  // killing the process: car-pages.ts also calls them through loadContext(), and
  // the watcher in server.ts pokes that every ten seconds. A typo in text/*.txt
  // in the middle of a working day should cost one line in the terminal, not the
  // whole local site.
  let ctx: BlocksContext;
  try {
    ctx = loadContext();
  } catch (error) {
    return fail((error as Error).message);
  }

  const allPages = pages();
  if (!allPages.length) fail("there is not a single page in www/");

  const changed: string[] = [];
  const unmarked: string[] = [];
  const skipped: string[] = [];
  const byLang: Record<string, number> = { ru: 0, en: 0, ka: 0 };

  for (const path of allPages) {
    const name = relative(ROOT, path);
    const parsed = classify(path);
    if (!parsed) { skipped.push(name); continue; }
    const [lang] = parsed;
    byLang[lang] += 1;

    MARKER.lastIndex = 0;
    if (!MARKER.test(readFileSync(path, "utf8"))) unmarked.push(name);

    if (applyToFile(path, ctx)) changed.push(name);
  }

  console.log(`Blocks: ${Object.keys(ctx.blocks).length} — ${Object.keys(ctx.blocks).sort().join(", ")}`);
  console.log(`Values: ${Object.keys(ctx.data).length} shared + ${Object.keys(ctx.texts.ru).length} per language`);
  console.log(`Pages: ${Object.values(byLang).reduce((a, b) => a + b, 0)} — ` +
              LANGS.map((l) => `${l}: ${byLang[l]}`).join(", "));
  for (const name of skipped) console.log(`Not a language page, skipped: ${name}`);

  if (changed.length) {
    console.log(`Updated: ${changed.length}`);
    for (const name of changed) console.log(`  • ${name}`);
  } else {
    console.log("Nothing to update — everything already matches.");
  }

  if (unmarked.length) {
    console.log("\n⚠ Pages with no markers (header and footer will not update in them):");
    for (const name of unmarked) console.log(`  • ${name}`);
  }
}

// Run directly (node update.ts) — do the work. Imported from car-pages.ts for
// loadContext()/fillBlocks()/applyToFile() — stay quiet, do not call main() and
// do not print update.ts diagnostics twice.
if (process.argv[1] && import.meta.filename === process.argv[1]) main();
