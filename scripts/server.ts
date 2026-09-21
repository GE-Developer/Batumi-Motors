/*
  server.ts — a local server for looking at the site in a browser.

  Run:      node server.ts
  Address:  http://localhost:4444/ru/

  The site is up for as long as the command runs. Ctrl+C, or closing the window,
  shuts it down.

  Why a custom one rather than something off the shelf. Because of a single
  line: Cache-Control: no-store. It forbids the browser to remember pages.
  Without it, renaming an address leaves the browser showing the version it
  saved before the edits, the links inside it lead nowhere, and half an hour
  goes into hunting a breakage that does not exist. Now every tab refresh takes
  the file from disk again.

  On a real host you must not do this — there the cache is wanted, it makes the
  site faster. This file never reaches the server, it is for desk work only.

  This server's second job is watching the database. Once every ten seconds it
  asks Supabase whether anything changed in the cars or the deals, and if so it
  rebuilds the affected pages itself. Change a price in the dashboard, wait ten
  seconds, refresh the tab — the new price is there. Nothing to run by hand.

  It watches each table separately: if one breaks, the other keeps updating.
  While the deals table does not exist, it says so once and gets on with the cars.

  The watcher only runs while this terminal is open. Once the site moves to a
  host, a webhook takes its place: Supabase triggers the build itself, and there
  is no ten-second wait.
*/

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, sep } from "node:path";
import { fetchCars, render as renderCars, forgetPhotos } from "./cars.ts";
import { fetchDeals, render as renderDeals } from "./deals.ts";
import { render as renderCarPages } from "./car-pages.ts";
import { readData } from "../lib/site.ts";

const ROOT = join(import.meta.dirname, "..", "www");
const PORT = 4444;
// Loopback: the draft is for this desk, not for the network around it.
const HOST = "127.0.0.1";
const WATCH_INTERVAL_SEC = 10;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

// Short answers with no file behind them get a type too. Without one the
// browser guesses.
const PLAIN = { "Content-Type": "text/plain; charset=utf-8" };

async function readableFile(path: string): Promise<string | null> {
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

// The handler is its own function and the call carries a .catch(). The reason is
// not tidiness: an exception inside an ASYNCHRONOUS createServer handler is
// caught by nobody, becomes an unhandled promise rejection and kills the whole
// process. Before this fix a single request like /% switched off the site along
// with the database watcher, and you only found out by running into "I can't
// open the site".
const server = createServer((request, answer) => {
  serve(request, answer).catch((error: Error) => {
    console.error(`✖ ${request.method} ${request.url} — ${error.message}`);
    if (!answer.headersSent) answer.writeHead(500, PLAIN);
    answer.end("500");
  });
});

async function serve(request: IncomingMessage, answer: ServerResponse): Promise<void> {
  // Broken percent-encoding ("/%", "/%zz", "/%E0%A4%A") makes decodeURIComponent
  // throw. That is not a missing file but a malformed request — answer 400 and
  // carry on living.
  let urlPath: string;
  try {
    urlPath = decodeURIComponent((request.url ?? "/").split("?")[0]);
  } catch {
    answer.writeHead(400, PLAIN).end("400");
    return;
  }

  // normalize plus a prefix check: without it a request like /../../ can pull
  // any file off the disk. The trailing separator is essential: without it the
  // check is passed by a sibling folder whose name merely STARTS with "www" —
  // www2, www-backup, www.old. Verified: without sep a file from such a folder
  // was served to the outside.
  const fullPath = normalize(join(ROOT, urlPath));
  if (fullPath !== ROOT && !fullPath.startsWith(ROOT + sep)) {
    answer.writeHead(403, PLAIN).end("403");
    return;
  }

  // A folder → the index.html inside it.
  let file = (await readableFile(fullPath)) ?? (await readableFile(join(fullPath, "index.html")));

  if (!file) {
    // The "not found" page — in the language of the section that was knocked on.
    const lang = ["ru", "en", "ka"].find((l) => urlPath.startsWith(`/${l}/`)) ?? "en";
    file = await readableFile(join(ROOT, lang, "404.html"));
    answer.statusCode = 404;
    if (!file) {
      answer.writeHead(404, PLAIN).end("404");
      return;
    }
  }

  // toLowerCase(): a .JPG straight off a camera is the same picture as .jpg, and
  // without folding the case it went to the browser as "download this file".
  answer.setHeader("Content-Type", TYPES[extname(file).toLowerCase()] ?? "application/octet-stream");
  answer.setHeader("Cache-Control", "no-store");
  // Forbid the browser to guess the type against the header.
  answer.setHeader("X-Content-Type-Options", "nosniff");
  answer.end(await readFile(file));
}

// The port is taken — almost always by a forgotten server in another terminal
// window. Staying quiet is not an option: you would be looking at pages served
// by some other server, wondering why nothing updates.
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`✖ Port ${PORT} is already taken by something — most likely a server`);
    console.error("  started in another terminal window. Switch it off there with Ctrl+C.");
    console.error("  Can't find the window — run:  lsof -tiTCP:" + PORT + " | xargs kill");
    process.exit(1);
  }
  throw error;
});

// The second argument is the point: bound to the loopback address, the draft
// answers this computer and nothing else. Left out, node listens on every
// network interface and the draft opens from any device on the same Wi-Fi —
// which is how it was until 21.09.2026, and how the site used to be looked at
// on a phone. That convenience is what was given up here: type the Mac's
// address into a phone now and nothing answers.
server.listen(PORT, HOST, () => {
  console.log(`Site is up: http://localhost:${PORT}/ru/`);
  console.log("This computer only — not reachable from the phone or the network");
  console.log(`Watching the database: checking every ${WATCH_INTERVAL_SEC} s`);
  console.log("To stop — Ctrl+C");
  // readData() inside watch() now throws an Error rather than killing the
  // process itself (see lib/site.ts). We catch it here and kill the process
  // ourselves, with the same code and the same message fail() used to produce —
  // before this fix a data.txt broken at startup already stopped the whole
  // server, so the behaviour is unchanged; we only keep it from going down as
  // an unhandled promise rejection.
  watch().catch((error: Error) => {
    console.error("✖ " + error.message);
    process.exit(1);
  });
});

/** One watched table: go and fetch it, compare with last time, and lay it out
    across the pages if it changed. */
async function watchTable<T>(
  name: string,
  load: () => Promise<T[]>,
  apply: (rows: T[]) => Promise<string[]>,
  previous: Map<string, string>,
  complaints: Map<string, string>,
): Promise<void> {
  const timeNow = () => new Date().toLocaleTimeString("en-GB");
  try {
    const rows = await load();
    const snapshot = JSON.stringify(rows);
    const prior = previous.get(name);

    if (snapshot !== prior) {
      const changed = await apply(rows);
      if (prior === undefined) {
        console.log(`${timeNow()}  ${name}: ${rows.length}` +
                    (changed.length ? ", pages were out of date — rebuilt" : ", pages already match"));
      } else if (changed.length) {
        console.log(`${timeNow()}  ${name} changed → rebuilt ${changed.length} page(s), ` +
                    `on the site: ${rows.length}`);
      } else {
        console.log(`${timeNow()}  ${name} changed, but it does not show on the pages ` +
                    "(not the kind of edit that reaches them)");
      }
      previous.set(name, snapshot);
    }

    if (complaints.get(name)) {
      console.log(`✓ ${timeNow()}  ${name}: the database is back`);
      complaints.delete(name);
    }
  } catch (error) {
    // The internet blinked, the database lay down, or the table is not there
    // yet. The server does not fall over: it complains once rather than every
    // ten seconds, and keeps waiting.
    const message = (error as Error).message;
    if (complaints.get(name) !== message) {
      console.log(`⚠ ${timeNow()}  ${name}: ${message}`);
      console.log("  The site works, still watching. It shows up — I pick it up.");
      complaints.set(name, message);
    }
  }
}

/** Every WATCH_INTERVAL_SEC seconds, walk all the watched tables. */
async function watch(): Promise<void> {
  const data = readData();
  const previous = new Map<string, string>();
  const complaints = new Map<string, string>();

  for (;;) {
    // One snapshot of the cars table serves BOTH the card grid and the
    // individual car pages: both consumers look at the same table through one
    // HTTP request instead of poking the database twice every ten seconds.
    await watchTable("cars", () => fetchCars(data),
                  async (rows) => {
                    forgetPhotos();
                    const carsChanged = await renderCars(rows, data);
                    const pagesChanged = await renderCarPages(rows, data);
                    return [...carsChanged, ...pagesChanged];
                  },
                  previous, complaints);
    await watchTable("deals", () => fetchDeals(data),
                  (rows) => renderDeals(rows),
                  previous, complaints);
    await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_SEC * 1000));
  }
}
