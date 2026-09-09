/*
  lib/site.ts — what cars.ts, deals.ts and everything that comes later all need.

  There is nothing about cars or deals in here: only the shared moves — read a
  dictionary, go to the database, replace a chunk of a page between markers.
  Add a third entity and it takes these from here instead of copying them.
*/

import { readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

export const ROOT = join(import.meta.dirname, "..");
export const LANGS = ["ru", "en", "ka"] as const;
export type Lang = (typeof LANGS)[number];
export type Values = Record<string, string>;

// A marker takes up a whole line. Groups: 1 — indentation, 2 — name.
// The at sign is what comes from the database. The hash (update.ts) is what
// comes from files.
export const MARKER = /^([ \t]*)<!--@([a-z-]+)-->\n[\s\S]*?^[ \t]*<!--@-->[ \t]*$/gm;

export function fail(message: string): never {
  console.error("✖ " + message);
  process.exit(1);
}

/** A "key = value" file into a dictionary. Throws Error rather than killing the
    process: this function (via readData()) is called by a default parameter
    value in fetchCars()/fetchDeals()/render() — that is, it is reachable from
    code the watcher in server.ts pokes every ten seconds. process.exit() here
    would be a landmine: a try/catch around the call would not intercept it, and
    the server would simply die on the spot over a typo in data.txt. For a
    precedent, the same fix is already in place for readPairs()/readData()/
    readTexts()/readBlocks() inside update.ts. */
export function readPairs(path: string): Values {
  const values: Values = {};
  const name = basename(path);
  readFileSync(path, "utf8").split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    if (!line.includes("="))
      throw new Error(`${name}, line ${index + 1}: no "=" sign — "${line}"`);
    values[line.slice(0, line.indexOf("=")).trim()] = line.slice(line.indexOf("=") + 1).trim();
  });
  return values;
}

export function readData(): Values {
  const data = readPairs(join(ROOT, "data.txt"));
  for (const key of ["db-url", "db-key"])
    if (!(key in data)) throw new Error(`data.txt has no "${key}" key`);
  return data;
}

export function readText(lang: Lang): Values {
  return readPairs(join(ROOT, "text", `${lang}.txt`));
}

/** A word from the dictionary. No key means we throw rather than kill the
    process: render() from cars.ts/deals.ts/car-pages.ts is poked by the watcher
    in server.ts every ten seconds, and process.exit() here would mean a typo in
    text/*.txt takes down the whole local site rather than one page. Whoever
    called decides: each script's main() catches and calls fail(), the watcher
    prints a warning once and tries again in 10 seconds. */
export function word(text: Values, key: string, page: string): string {
  if (!(key in text))
    throw new Error(`${page}: the dictionary has no "${key}" key. Add it to all three text/*.txt files`);
  return text[key];
}

/** Substitution of the form {key} → value. One mechanism for the whole project:
    update.ts uses it for blocks/*.html and car-pages.ts for templates/car.html.
    It is not called "render" — that name is already taken in cars.ts/deals.ts
    with a different meaning ("build an HTML chunk"), and confusing the two when
    reading the files back to back is not worth it. */
export function substitute(text: string, values: Values): string {
  for (const [key, value] of Object.entries(values)) text = text.split("{" + key + "}").join(value);
  return text;
}

/** Which form of the word this number takes.

    Russian needs three forms, one each for 1, 2 and 5.
    English needs two: 1 car, 2 cars.
    Georgian needs one: a numeral is always followed by the singular —
    2 ავტომობილი, not ავტომობილები. That is not a typo in the dictionary.
*/
export function plural(lang: Lang, n: number): "one" | "few" | "many" {
  if (lang === "ru") {
    if (n % 10 === 1 && n % 100 !== 11) return "one";
    if (n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14)) return "few";
    return "many";
  }
  if (lang === "en") return n === 1 ? "one" : "many";
  return "one";
}

/** Rows from a Supabase table, in sort_order.

    We throw the error rather than kill the process. Whoever called decides: a
    one-off run is right to stop and say so, while the watcher in server.ts should
    shrug and try again. Wi-Fi blinking is no reason to fall over. */
export async function fetchRows<T>(data: Values, table: string, fields: string): Promise<T[]> {
  const url = `${data["db-url"].replace(/\/+$/, "")}/rest/v1/${table}` +
              `?select=${fields}&order=sort_order`;
  let answer: Response;
  try {
    answer = await fetch(url, {
      headers: { apikey: data["db-key"], Authorization: "Bearer " + data["db-key"] },
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new Error(`could not reach the database: ${(error as Error).message}`);
  }
  if (!answer.ok)
    throw new Error(`table ${table} answered ${answer.status}: ` +
                    `${(await answer.text()).slice(0, 200)}`);
  return (await answer.json()) as T[];
}

/** Replace chunks of a page between markers. Returns true if the file was touched. */
export function fillMarkers(page: string, pieces: Values, known: string): boolean {
  const path = join(ROOT, page);
  const before = readFileSync(path, "utf8");

  MARKER.lastIndex = 0;
  const after = before.replace(MARKER, (full, indent: string, name: string) => {
    // Somebody else's marker — not our business, leave it as it is: one page can
    // carry markers belonging to different scripts.
    if (!(name in pieces)) return full;
    return `${indent}<!--@${name}-->\n${pieces[name]}\n${indent}<!--@-->`;
  });

  for (const name of Object.keys(pieces))
    if (!before.includes(`<!--@${name}-->`))
      console.log(`  ⚠ ${page}: no <!--@${name}--> marker, ${known} will not land in it`);

  if (after === before) return false;
  writeFileSync(path, after, "utf8");
  return true;
}

/** data.txt keys that have no business in {token} substitution.

    substitute() walks over an ALREADY assembled page, where text from the
    database sits next to the markup. While the access key was in this
    dictionary, the string "{db-key}" in a car description silently turned into
    the key itself, right there in the published HTML. No block needs these
    tokens in its markup — verified: {db-url}, {db-key} and {photos-url} appear
    neither in blocks/*.html, nor in templates/car.html, nor on any built page.
    Programmatically (data["photos-url"]) they of course work as they always did. */
const PRIVATE_KEYS = new Set(["db-url", "db-key", "photos-url"]);

/** data.txt without the database credentials — what is safe to hand to substitute(). */
export function publicData(data: Values): Values {
  const out: Values = {};
  for (const [key, value] of Object.entries(data))
    if (!PRIVATE_KEYS.has(key)) out[key] = value;
  return out;
}

/** Escaping for text that comes from the database and lands in markup.
    Without it a quote or a less-than sign in a description breaks the page. */
export function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // The curly brace is not about markup but about our own substitution
    // mechanism: substitute() walks over an ALREADY assembled page holding text
    // from the database. A car description containing "{db-key}" silently turned
    // into the access key itself in the published HTML, and "{anything}" broke
    // the page build via the leftover-token check. The entity renders as the
    // same brace — nothing changes on screen.
    .replace(/\{/g, "&#123;");
}

/** The same, but for text inside an HTML attribute (alt="…", content="…").
    escape() itself is left alone — it works on text nodes across the whole
    project (headings, paragraphs, captions), and a quote is harmless there:
    it cannot close a node, only "<" closes a tag. Inside an attribute the
    string sits between double quotes, so its own quote has to become &quot;,
    otherwise it closes the attribute early and everything after it (the
    remaining attributes, the rest of the tag) ends up as text on the page.
    escapeAttr() is built on top of escape() rather than copying it: fix the
    &/</> escaping in one place and it is fixed for both text and attributes. */
export function escapeAttr(text: string): string {
  return escape(text).replace(/"/g, "&quot;");
}
