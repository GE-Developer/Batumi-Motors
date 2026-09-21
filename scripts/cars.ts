/*
  cars.ts — takes the cars from the database and lays them out across the fleet
  pages, in all three languages.

  How it differs from update.ts
      update.ts distributes what lives in files: header, footer, phone number.
      Its markers carry a hash:           <!--#footer--> … <!--#-->
      cars.ts distributes what lives in the database: the cars themselves.
      Its markers carry an at sign:       <!--@cars-->   … <!--@-->

      Hash means from files, at sign means from the database. The scripts do not
      get in each other's way, and the order they run in does not matter: each
      one sees only its own markers.

  What it fills
      <!--@cars-->        the grid of cards on the fleet page
      <!--@fleet-size-->  the number of cars on the "About" page

  Where it takes things from
      data.txt      database address, key, the start of the photo address
      text/*.txt    the translation of codes: the "economy" code becomes the word
                    for it in each of the three languages
      cars table    the cars themselves: make, year, price, photos

      The database holds codes, not words. So a new car needs nothing translated
      again, and forgetting Georgian is impossible: a missing key stops the
      script, and it says which one.

  Only cars with the is_active flag are shown. Switch it off in the dashboard and
  the car disappears from all three languages on the next run.

  Run:   node cars.ts
*/

import { LANGS, fail, readData, readText, fetchRows, fillMarkers, word, plural, escape, escapeAttr,
         type Lang, type Values } from "../lib/site.ts";
import { minPrice, type Tariffs } from "../lib/tariffs.ts";

// select=* — a card on /cars/ needs only some of the columns, but an individual
// car's page (car-pages.ts) needs literally all of them. One shared query
// instead of two field lists: the watcher in server.ts goes to the database once
// per cycle, and a column can be added in Supabase without remembering to add it
// to the script — "*" is immune to forgotten fields by construction.
const FIELDS = "*";

// The same slug parsing as in car-pages.ts:61. That script does not create a
// page for a car with an unusable slug — so a link from here would lead to a
// 404, and that has to be said out loud rather than silently producing a broken
// card.
const SLUG_OK = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type Car = {
  id: string;
  slug: string;
  is_active: boolean;
  /* The "show on the home page" flag. The column may not exist in the database
     yet: the query goes out with select=*, so a missing field arrives empty and
     breaks nothing — it just means no car is pinned. */
  is_pinned?: boolean | null;
  sort_order: number;
  brand: string;
  model: string;
  year: number;
  class: string | null;
  body: string | null;
  transmission: string | null;
  fuel: string | null;
  fuel_grade: string | null;
  tank_l: number | null;
  drive: string | null;
  steering: string | null;
  seats: number | null;
  doors: number | null;
  engine_l: number | null;
  power_hp: number | null;
  torque_nm: number | null;
  acceleration_s: number | null;
  consumption_l: number | null;
  trunk_l: number | null;
  clearance_mm: number | null;
  weight_kg: number | null;
  features: string[] | null;
  tariffs: Tariffs | null;
  deposit_usd: number | null;
  insurance: string | null;
  min_driver_age: number | null;
  min_experience_y: number | null;
  mileage_limit_km: number | null;
  mileage_free_from_days: number | null;
  delivery_city_usd: number | null;
  delivery_airport_usd: number | null;
  cross_border: boolean | null;
  photos: string[] | null;
  content: Record<string, { description?: string }> | null;
  created_at: string;
  updated_at: string;
};

export async function fetchCars(data: Values = readData()): Promise<Car[]> {
  return await fetchRows<Car>(data, "cars", FIELDS);
}

/** Whether the file is actually there. We do not ship a broken link to a page:
    an empty "photo coming soon" frame looks far better than a broken image.
    Exported — car-pages.ts checks gallery photos the same way and through the
    same cache: a card's photo and a car page's photo are checked once per
    watcher cycle, not twice. */
const checked = new Map<string, boolean>();
export async function photoExists(url: string): Promise<boolean> {
  if (!checked.has(url)) {
    let verdict: boolean;
    try {
      const answer = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10000) });
      // 5xx — the storage itself is unwell, while the photo is right where it
      // was. We treat it as existing: pulling the photos off the whole site over
      // a minute of illness on the Supabase side is worse than keeping an image.
      verdict = answer.ok || answer.status >= 500;
    } catch {
      // Could not reach it at all: the Wi-Fi blinked, the timeout ran out. That
      // does NOT mean the photo is gone. This used to return false — and one
      // such misfire silently swapped the photos for the "coming soon"
      // placeholder in all three languages at once, with the database watcher
      // writing the loss straight into the files. We do not remember the answer:
      // we will ask again next time round.
      return true;
    }
    checked.set(url, verdict);
  }
  return checked.get(url)!;
}

/** A car's photos, ready to be put on a page: short paths expanded against
    photos-url, addresses that answer with nothing dropped.

    It lives here rather than in car-pages.ts because it is the pair to the
    photoExists() cache above, and because the gallery is no longer its only
    caller — the car's structured data has to name the same pictures the page
    shows, and two lists built by two pieces of code drift apart. */
export async function livePhotos(car: Car, data: Values): Promise<string[]> {
  // The photos column can hold either a short path "slug/file.jpg" or a whole
  // address — the "Copy URL" button in the Supabase panel gives exactly the
  // whole one. The address used to be glued onto photos-url as a second piece,
  // producing nonsense like "…/public/Cars/https://…", so a ready address is
  // taken as it is.
  const urls = (car.photos ?? [])
    .map((path) => /^https?:\/\//.test(path) ? path
      : data["photos-url"].replace(/\/+$/, "") + "/" + path.replace(/^\/+/, ""));

  const working: string[] = [];
  for (const url of urls) {
    if (await photoExists(url)) working.push(url);
    else complainOnce(car.slug, url);
  }
  return working;
}

/** Which loss we have already mentioned. The same photo is checked by the card
    and by the car page, each in three languages: without this memory one missing
    photo produced six identical lines in the terminal. */
const complained = new Set<string>();

/** Mention a missing photo once per round, not six times. */
export function complainOnce(slug: string, url: string): void {
  const line = `  ⚠ ${slug}: no photo at ${url}`;
  if (complained.has(line)) return;
  complained.add(line);
  console.log(line);
}

/* ── An image sized for the screen ────────────────────────────────────────
   Storage holds one 1500×1000 file, while a card shows it about 390 points
   wide. On an ordinary screen the browser downloaded and decoded four times
   more pixels than it needed — and did it right in the middle of scrolling, as
   the card came up from below.

   Supabase can serve a smaller copy from the render/image address. We ask for a
   few widths and let the browser pick one for its screen: on an ordinary screen
   it takes a narrow copy, on retina a wide one.

   src keeps the ORIGINAL. If transformations get switched off in storage or the
   quota runs out, the srcset simply is not built and everything runs as before —
   we check this once per build rather than on every card. */
const OBJECT_PATH = "/storage/v1/object/public/";
const RENDER_PATH = "/storage/v1/render/image/public/";

/** The address of a smaller copy. null means the photo does not live in our
    storage, and such a photo is not touched at all. */
export function resized(url: string, width: number): string | null {
  const at = url.indexOf(OBJECT_PATH);
  if (at === -1) return null;
  // resize=contain is mandatory. By default Supabase crops in cover mode: for
  // "width=600" it hands back 600×1000 — that is, it simply CUTS a strip out of
  // the middle of the frame instead of scaling the whole photo down, and the car
  // ends up past the edge. With contain you get an honest 600×400.
  return url.slice(0, at) + RENDER_PATH + url.slice(at + OBJECT_PATH.length) +
         `?width=${width}&resize=contain&quality=80`;
}

let resizeWorks: boolean | null = null;

/** A bare "address width" list for srcset. An empty string means storage cannot
    resize, and the browser takes the original from src, as before. */
export async function sizedSrcset(url: string, widths: number[]): Promise<string> {
  if (resizeWorks === null) {
    const probe = resized(url, widths[0]);
    resizeWorks = probe !== null && (await photoExists(probe));
    if (!resizeWorks)
      console.log("  ⚠ storage is not serving smaller copies — photos will go out as originals");
  }
  if (!resizeWorks) return "";
  return widths.map((w) => `${resized(url, w)} ${w}w`).join(", ");
}

/** The same, but as attributes ready for an <img> tag. */
export async function sizedAttrs(url: string, widths: number[], sizes: string): Promise<string> {
  const set = await sizedSrcset(url, widths);
  return set ? ` srcset="${escapeAttr(set)}" sizes="${escapeAttr(sizes)}"` : "";
}

/* The widths and sizes are set FROM MEASUREMENTS of the real card, not by eye:
   erring low gives mush, erring high only costs traffic, so everything carries a
   small margin upwards.

   The fleet grid lays itself out (auto-fill from 330px), and the card width
   changes in jumps:
     window up to ~750 — one column,   the photo takes 86–93% of the window width
     window 800–1100   — two columns,  43–45%
     window from 1200  — three columns, and then it hits the width of the content
                         column: 361–381px and it stops growing.
   Hence "400px" as the third case — not a fraction of the window but an exact
   number.

   The fractions are trimmed close rather than padded, and the 1000 step exists
   precisely for that: the browser takes the smallest copy that is NOT SMALLER
   than it needs, and an inflated fraction bumps it up a step. At double pixel
   density and a window around 900 points, the old "47vw" asked for 846 points
   and dragged it onto the 1200 copy instead of 800 — twice the pixels to decode
   where a smaller copy was enough. */
export const CARD_WIDTHS = [400, 600, 800, 1000, 1200];
export const CARD_SIZES = "(min-width: 1200px) 400px, (min-width: 1000px) 46vw, " +
                          "(min-width: 800px) 44vw, 95vw";

/** Forget which photos were checked: upload a new one and we will see it. */
export function forgetPhotos(): void {
  checked.clear();
  resizeWorks = null;
  complained.clear();
}

/** "from $35 per day" — as a whole template, not assembled from pieces.

    In Georgian "from" goes at the end: დღეში $35-დან. Build the string out of
    separate words and Georgian falls apart. So the dictionary holds the whole
    phrase, and a hash marks the place for the price.
*/
function priceLine(text: Values, price: number, page: string): string {
  const template = word(text, "price-from", page);
  if (!template.includes("#"))
    // throw, not fail(): this function is called from card() inside render(),
    // and the watcher in server.ts pokes render() every 10 seconds.
    // process.exit() here would mean a malformed line in text/*.txt takes down
    // the whole server.
    throw new Error(`${page}: the hash is missing from the price-from key — the script has nowhere to put the price`);
  const [before, after] = [template.slice(0, template.indexOf("#")),
                           template.slice(template.indexOf("#") + 1)];

  // Air around the number only where the text has a space. In Georgian "-დან"
  // is glued tight to the number and must not be pushed away: it is a word
  // ending, not a separate caption.
  const classes = ["price__value"];
  if (/\s$/.test(before)) classes.push("price__value--gap-left");
  if (/^\s/.test(after)) classes.push("price__value--gap-right");

  // The template pieces are ours, from text/*.txt, and right now they hold
  // neither angle brackets nor quotes. escape() here is not about distrusting
  // our own file but about a single rule: nothing reaches the markup bypassing
  // escaping — otherwise one day somebody forgets this path was special.
  return `<span class="muted small">${escape(before)}</span>` +
         `<span class="${classes.join(" ")}">$${price}</span>` +
         `<span class="muted small">${escape(after)}</span>`;
}

/** The heading level for a car's name. It differs from page to page, and that is
    not decoration: on the fleet page the cards come directly under the page's
    <h1>, while on the home page they come under the "Fleet" <h2>. Nail the level
    down and one of the two pages gets a hole in its outline: h1 → h3. A screen
    reader reads the page by exactly that outline. The level changes nothing
    visually: the whole look of .card__name comes from the class. */
type Level = "h2" | "h3";

async function card(car: Car, lang: Lang, text: Values, data: Values,
                    first: boolean, page: string, level: Level): Promise<string> {
  const name = `${car.brand} ${car.model}`;
  // escapeAttr(), not merely escape(): the caption goes into alt="…", which is
  // an attribute — a quote in the make or model (should there ever be one) has
  // to become &quot;, otherwise it closes alt early and tears up the rest of the
  // tag.
  const caption = escapeAttr(word(text, "photo-alt", page).replace("#", `${name} ${car.year}`));

  let media: string;
  const path = (car.photos ?? [])[0];
  // The photos column can hold either a short path "slug/file.jpg" or a whole
  // address — the "Copy URL" button in the Supabase panel gives exactly the
  // whole one. The address used to be glued onto photos-url as a second piece,
  // producing nonsense like "…/public/Cars/https://…", so a ready address is
  // taken as it is.
  const photoUrl = !path ? null
    : /^https?:\/\//.test(path) ? path
    : data["photos-url"].replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
  if (photoUrl && (await photoExists(photoUrl))) {
    // The first card loads immediately, the rest when they are scrolled to.
    const loadingAttrs = first ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"';
    // escapeAttr() on the address: the file name comes from the database, and a
    // quote in it would close src early, turning the rest of the tag into markup
    // on the page.
    const sized = await sizedAttrs(photoUrl, CARD_WIDTHS, CARD_SIZES);
    media = `<img class="photo" src="${escapeAttr(photoUrl)}" alt="${caption}"${sized}\n` +
            `                   width="545" height="366" ${loadingAttrs} decoding="async">`;
  } else {
    if (photoUrl) complainOnce(car.slug, photoUrl);
    media = `<div class="photo--empty">${escape(word(text, "photo-soon", page))}</div>`;
  }

  // Clicking the card leads to the car's page. It does not exist yet — it will,
  // and the links will start working on their own, with nothing to change here.
  if (!SLUG_OK.test(car.slug))
    console.log(`  ⚠ ${car.brand} ${car.model}: the slug "${car.slug}" is unusable in an address — ` +
                "there will be no car page, and the link on the card will lead to a 404");
  const carHref = escapeAttr(`/${lang}/cars/${car.slug}/`);

  // The button opens WhatsApp with the message already written: the manager sees
  // straight away which car this is about, and the client has nothing to type.
  const message = word(text, "wa-text", page).replace("#", `${name} ${car.year}`);
  const bookingUrl = `https://wa.me/${data["whatsapp"]}?text=${encodeURIComponent(message)}`;

  const chips: string[] = [];
  if (car.class) chips.push(word(text, `class-${car.class}`, page));
  if (car.transmission) chips.push(word(text, `trans-${car.transmission}`, page));
  if (car.seats)
    chips.push(`${car.seats} ${word(text, "seats-" + plural(lang, car.seats), page)}`);

  const chipsHtml = chips.map((c) => `                <li class="chip">${escape(c)}</li>`).join("\n");

  return `        <li>
          <article class="card">

            <div class="card__media">
              ${media}
            </div>

            <div class="card__body">
              <${level} class="card__name">
                <a href="${carHref}">${escape(name)}<span class="card__year">${car.year}</span></a>
              </${level}>

              <ul class="chips">
${chipsHtml}
              </ul>

              <div class="card__foot">
                <p class="price">${priceLine(text, minPrice(car.tariffs ?? {}), page)}</p>
                <a class="btn btn--ghost card__more" href="${bookingUrl}" rel="noopener">${escape(word(text, "cta", page))}</a>
              </div>
            </div>

          </article>
        </li>`;
}

/** Lay the cars out across the pages. Returns the list of files touched.
    Separate from main because the watcher in server.ts does the same thing: it
    notices an edit in the database and calls this function itself. */
export async function render(cars: Car[], data: Values = readData()): Promise<string[]> {
  const changed: string[] = [];

  for (const lang of LANGS) {
    const page = `www/${lang}/cars/index.html`;
    const text = readText(lang);

    const wrap = (list: string[]) =>
      '      <ul class="grid">\n' + list.join("\n") + "\n      </ul>";

    const cards: string[] = [];
    for (const [i, car] of cars.entries())
      cards.push(await card(car, lang, text, data, i === 0, page, "h2"));
    if (fillMarkers(page, { cars: wrap(cards) }, "cars")) changed.push(page);

    // The home page is a shop window, not a catalogue: only cars with the
    // is_pinned flag. If none is pinned (or the column is not in the database
    // yet), we show the whole fleet: an empty window is worse than a full one.
    const homeCars = `www/${lang}/index.html`;
    const pinned = cars.filter((car) => car.is_pinned);
    const forHome = pinned.length ? pinned : cars;

    // The home page cards are built afresh rather than reused: the first card
    // gets loading="eager", and on the home page the first one must be the first
    // PINNED car, not the first car of the fleet.
    const homeCards: string[] = [];
    for (const [i, car] of forHome.entries())
      homeCards.push(await card(car, lang, text, data, i === 0, homeCars, "h3"));
    if (fillMarkers(homeCars, { cars: wrap(homeCards) }, "cars")) changed.push(homeCars);

    // The number of cars on the "About" page — from the database as well.
    // Otherwise it drifts away from the fleet one day and nobody notices.
    const about = `www/${lang}/about/index.html`;
    const counter = `          <dt class="stat__num">${cars.length}</dt>`;
    if (fillMarkers(about, { "fleet-size": counter }, "the car count")) changed.push(about);
  }
  return changed;
}

async function main(): Promise<void> {
  // readData() now throws an Error rather than killing the process (see
  // lib/site.ts) — caught right here, otherwise a one-off run on a malformed
  // data.txt falls over with a raw stack instead of the usual "✖ …".
  let data: Values;
  try {
    data = readData();
  } catch (error) {
    return fail((error as Error).message);
  }
  if (!("photos-url" in data)) fail('data.txt has no "photos-url" key');

  let cars: Car[];
  try {
    cars = await fetchCars(data);
  } catch (error) {
    return fail((error as Error).message);
  }

  if (!cars.length)
    fail("the database returned zero cars. Most likely none of them has the " +
         "is_active flag — switch them on in the dashboard, Table Editor → cars");

  console.log(`Cars in the database with the is_active flag: ${cars.length}`);
  const pinnedCount = cars.filter((car) => car.is_pinned).length;
  console.log(pinnedCount
    ? `On the home page: ${pinnedCount} pinned (the is_pinned flag)`
    : "On the home page: the whole fleet — no car has the is_pinned flag");
  for (const car of cars)
    console.log(`  • ${car.brand} ${car.model} ${car.year} — from $${minPrice(car.tariffs ?? {})}`);

  // render() can now throw an Error (see priceLine/word) — caught right here so
  // that the output of a one-off run does not change: it used to be "fail()
  // inside render() kills the process on the spot", now it is "render() throws —
  // main() catches and calls fail()".
  let changed: string[];
  try {
    changed = await render(cars, data);
  } catch (error) {
    return fail((error as Error).message);
  }

  if (changed.length) {
    console.log(`Pages updated: ${changed.length}`);
    for (const page of changed) console.log(`  • ${page}`);
  } else {
    console.log("Nothing to update — everything already matches.");
  }
}

// Run directly (node cars.ts) — do the work. Imported from server.ts — stay quiet.
if (process.argv[1] && import.meta.filename === process.argv[1]) await main();
