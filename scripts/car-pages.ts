/*
  car-pages.ts — creates, updates and removes the pages of individual cars,
  www/<lang>/cars/<slug>/index.html, in all three languages.

  How it differs from cars.ts
      cars.ts is responsible for one thing — the grid of cards on /cars/: a chunk
      inside an already existing, half hand-written page. car-pages.ts solves a
      different problem — creating or removing a whole file that does not exist
      at all without the database. Different kinds of error and a different life
      cycle (a grid can simply be redrawn, a car page can also be deleted), so
      this is its own script rather than an extension of cars.ts. Both read the
      cars table — the right to a table is not the right to the file holding the
      script.

  Where it takes things from
      data.txt          domain, phone, whatsapp, photo address
      text/*.txt        the new "Car page" section of the dictionary, plus every
                         fleet key (class-*, feature-* and so on)
      templates/car.html the page template, {tokens}, no <!--@-->: 100% of the
                         HTML is derived from the database, so "do not touch the
                         rest" is not needed here — the file can be rewritten
                         whole on every run
      cars table        the car itself: every column, select=*

  Idempotence. The page is assembled ENTIRELY IN MEMORY (template →
  substitutions → fillBlocks() from update.ts) and compared with what is already
  on disk — we write only on a difference. That way a second run in a row says
  "nothing to update" instead of rewriting all thirty files from scratch every
  time.

  Errors — as agreed for render(), which the watcher in server.ts pokes every ten
  seconds:
      • structural (no templates/car.html, no car-title/car-meta key in any
        language at all) — throw Error, the whole run stops;
      • an invalid slug — skip the car entirely, its page is left out of all
        three languages;
      • incomplete content for one car (no description in some language, an empty
        price ladder) — skip all three languages of that car at once: otherwise
        one version's hreflang points at a page that does not exist, and Google
        stops trusting the whole set.

  Run:   node car-pages.ts
*/

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LANGS, ROOT, fail, escape, escapeAttr, word, plural, substitute, publicData, readData,
         jsonLd,
         type Lang, type Values } from "../lib/site.ts";
import { fetchCars, livePhotos, sizedAttrs, sizedSrcset, type Car } from "./cars.ts";
import { loadContext, fillBlocks, type BlocksContext } from "./update.ts";
import { steps, label, minPrice } from "../lib/tariffs.ts";

const TEMPLATE_PATH = join(ROOT, "templates", "car.html");

// The first line of every generated page — it is how the orphan-folder cleanup
// (cleanupLang) tells "a page this script made" from a hand-written file that is
// better left alone. The line lives ONCE — inside templates/car.html — and is
// here only for comparison when deleting.
const FINGERPRINT = "<!-- car-pages: generated automatically, do not edit by hand -->";

// Lowercase Latin letters, digits, hyphen as separator. A space gives a broken
// link, a slash gives unplanned folder nesting, non-Latin gives a dirty URL.
const SLUG_OK = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Two spaces of indentation per level — as everywhere on the site. Each build*()
    below takes a depth (how deep its opening tag sits in templates/car.html) and
    shifts itself as a whole by it — the same way sentencesToLines() in deals.ts
    takes a ready-made indent for joining lines. Without this the chunks are
    assembled in TS strings with hard-coded indentation and then inserted into the
    template at varying depths: you get exactly what the README warns against —
    generated pages that, unlike the eighteen hand-written ones, look sloppy when
    you simply open the file. */
const pad = (depth: number): string => "  ".repeat(depth);

// The order specs are printed in is fixed, not the column order in the database:
// that way the same spec is always in the same place for every car, and two pages
// open in neighbouring tabs are easier to compare.
type SpecField = { key: string; value: (car: Car, text: Values, lang: Lang, page: string) => string | null };

function unit(text: Values, key: string, value: number, page: string): string {
  return word(text, key, page).replace("#", String(value));
}

const SPEC_FIELDS: SpecField[] = [
  { key: "spec-class", value: (c, t, _l, p) => (c.class ? word(t, `class-${c.class}`, p) : null) },
  { key: "spec-body", value: (c, t, _l, p) => (c.body ? word(t, `body-${c.body}`, p) : null) },
  { key: "spec-transmission", value: (c, t, _l, p) => (c.transmission ? word(t, `trans-${c.transmission}`, p) : null) },
  { key: "spec-drive", value: (c, t, _l, p) => (c.drive ? word(t, `drive-${c.drive}`, p) : null) },
  { key: "spec-steering", value: (c, t, _l, p) => (c.steering ? word(t, `steering-${c.steering}`, p) : null) },
  // Seats and doors as a bare number: the label on the left has already said what
  // there are that many of. "Doors — 5 doors" read like a stutter, and all the
  // more so in Georgian, where a numeral is always followed by the singular.
  { key: "spec-seats", value: (c, _t, _l, _p) => (c.seats != null ? String(c.seats) : null) },
  { key: "spec-doors", value: (c, _t, _l, _p) => (c.doors != null ? String(c.doors) : null) },
  { key: "spec-fuel", value: (c, t, _l, p) => (c.fuel ? word(t, `fuel-${c.fuel}`, p) : null) },
  { key: "spec-fuel-grade", value: (c, t, _l, p) => (c.fuel_grade ? word(t, `grade-${c.fuel_grade}`, p) : null) },
  { key: "spec-engine", value: (c, t, _l, p) => (c.engine_l != null ? unit(t, "unit-l", c.engine_l, p) : null) },
  { key: "spec-power", value: (c, t, _l, p) => (c.power_hp != null ? unit(t, "unit-power", c.power_hp, p) : null) },
  { key: "spec-torque", value: (c, t, _l, p) => (c.torque_nm != null ? unit(t, "unit-torque", c.torque_nm, p) : null) },
  { key: "spec-acceleration", value: (c, t, _l, p) => (c.acceleration_s != null ? unit(t, "unit-acceleration", c.acceleration_s, p) : null) },
  { key: "spec-consumption", value: (c, t, _l, p) => (c.consumption_l != null ? unit(t, "unit-consumption", c.consumption_l, p) : null) },
  { key: "spec-tank", value: (c, t, _l, p) => (c.tank_l != null ? unit(t, "unit-l", c.tank_l, p) : null) },
  { key: "spec-trunk", value: (c, t, _l, p) => (c.trunk_l != null ? unit(t, "unit-l", c.trunk_l, p) : null) },
  { key: "spec-clearance", value: (c, t, _l, p) => (c.clearance_mm != null ? unit(t, "unit-clearance", c.clearance_mm, p) : null) },
  { key: "spec-weight", value: (c, t, _l, p) => (c.weight_kg != null ? unit(t, "unit-weight", c.weight_kg, p) : null) },
];

function buildSpecsSection(car: Car, lang: Lang, text: Values, page: string, depth: number): string {
  const rows: string[] = [];
  for (const field of SPEC_FIELDS) {
    const value = field.value(car, text, lang, page);
    if (value == null) continue;
    rows.push(`${pad(depth + 2)}<div class="specs__row"><dt>${escape(word(text, field.key, page))}</dt>` +
                `<dd>${escape(value)}</dd></div>`);
  }
  if (!rows.length) return "";
  return [
    `${pad(depth)}<section>`,
    `${pad(depth + 1)}<h2>${escape(word(text, "specs-title", page))}</h2>`,
    `${pad(depth + 1)}<dl>`,
    ...rows,
    `${pad(depth + 1)}</dl>`,
    `${pad(depth)}</section>`,
  ].join("\n");
}

/** Equipment — in the order the feature-* keys are declared in text/ru.txt, not
    in the order of the array elements from the database: that way the list is in
    the same order for every car and is easier to compare. ru is the source of
    order for all three languages: en/ka list the same keys in the same order
    today, but this way it is guaranteed even if they drift apart one day. */
function buildFeaturesSection(car: Car, texts: Record<Lang, Values>, lang: Lang, page: string, depth: number): string {
  const enabled = new Set(car.features ?? []);
  if (!enabled.size) return "";

  const order = Object.keys(texts.ru).filter((k) => k.startsWith("feature-"));
  const activeKeys = order.filter((k) => enabled.has(k.slice("feature-".length)));
  if (!activeKeys.length) return "";

  const items = activeKeys.map((k) => `${pad(depth + 2)}<li>${escape(word(texts[lang], k, page))}</li>`);
  return [
    `${pad(depth)}<section>`,
    `${pad(depth + 1)}<h2>${escape(word(texts[lang], "features-title", page))}</h2>`,
    `${pad(depth + 1)}<ul class="features">`,
    ...items,
    `${pad(depth + 1)}</ul>`,
    `${pad(depth)}</section>`,
  ].join("\n");
}

function buildPanels(car: Car, texts: Record<Lang, Values>, lang: Lang, page: string, depth: number): string {
  const sections = [
    buildSpecsSection(car, lang, texts[lang], page, depth + 1),
    buildFeaturesSection(car, texts, lang, page, depth + 1),
  ].filter(Boolean);
  if (!sections.length) return "";
  return [`${pad(depth)}<div class="panels">`, sections.join("\n\n"), `${pad(depth)}</div>`].join("\n");
}

/** Paragraphs as real <p>, split on \n\n from the database. We do not break on
    every period (the "sentence → its own line" trick from deals.ts): a car
    description already has structure — the database gave it in paragraphs — and
    it is right to respect that rather than override it with another trick
    invented for text with no structure. */
function buildDescription(car: Car, lang: Lang, text: Values, page: string, depth: number): string {
  const raw = car.content?.[lang]?.description;
  if (!raw) return "";

  const paragraphs = raw.split(/\n\n+/)
    .map((p) => escape(p.trim().replace(/\s*\n+\s*/g, " ")))
    .filter(Boolean);
  if (!paragraphs.length) return "";

  return [
    `${pad(depth)}<div class="prose">`,
    `${pad(depth + 1)}<h2>${escape(word(text, "description-title", page))}</h2>`,
    ...paragraphs.map((p) => `${pad(depth + 1)}<p>${p}</p>`),
    `${pad(depth)}</div>`,
  ].join("\n");
}

async function buildGallery(car: Car, text: Values, data: Values, page: string, depth: number): Promise<string> {
  const name = `${car.brand} ${car.model}`;
  // escapeAttr(), not escape(): alt="…" is an attribute, and a quote in the make
  // or model (should there be one) has to become &quot;, otherwise it closes alt
  // early.
  const alt = escapeAttr(word(text, "photo-alt", page).replace("#", `${name} ${car.year}`));

  // Measured: the large photo takes 93% of the window width on a phone, 50–55%
  // from 1000px, and from 1200px it hits 687–725px and stops growing.
  // A thumbnail is always around a hundred points.
  const MAIN_WIDTHS = [600, 900, 1200, 1500];
  const MAIN_SIZES = "(min-width: 1200px) 760px, (min-width: 1000px) 56vw, 95vw";
  const THUMB_WIDTHS = [200, 300];
  const THUMB_SIZES = "110px";

  // The same list the car's structured data names — see livePhotos() in cars.ts.
  const working = await livePhotos(car, data);

  // 0 photos — a placeholder frame instead of a gallery. It never disappears
  // entirely: it holds the shape of the 7fr/5fr column next to the price block,
  // both on a wide screen and on mobile.
  if (!working.length)
    return [
      `${pad(depth)}<div class="gallery">`,
      `${pad(depth + 1)}<div class="photo--empty">${escape(word(text, "photo-soon", page))}</div>`,
      `${pad(depth)}</div>`,
    ].join("\n");

  // Buttons, not links. A link led straight to the file in storage, and clicking
  // it landed a person on a bare Supabase address instead of the site. A button
  // switches the photo and opens it over the page (assets/js/gallery.js).
  const nav = ` data-close="${escapeAttr(word(text, "close", page))}"` +
              ` data-prev="${escapeAttr(word(text, "photo-prev", page))}"` +
              ` data-next="${escapeAttr(word(text, "photo-next", page))}"` +
              // The script swaps photos in the large frame and must change the
              // srcset along with the address: srcset is MORE IMPORTANT than src,
              // and while it still points at the previous photo, changing src
              // alone is invisible on screen. It takes the sizes for the large
              // frame from here too.
              ` data-sizes="${escapeAttr(MAIN_SIZES)}"`;
  // The large photo takes more than half the page width, a thumbnail about a
  // hundred points. Asking for the same 1500×1000 image for both means decoding
  // a hundred thousand extra pixels for every thumbnail.
  const [mainPhoto, ...rest] = working;
  const mainSized = await sizedAttrs(mainPhoto, MAIN_WIDTHS, MAIN_SIZES);
  const mainLines = [
    `${pad(depth + 1)}<button class="gallery__main" type="button">`,
    // escapeAttr() on the address: the file name comes from the database, and a
    // quote in it would close src early, turning the rest of the tag into markup.
    `${pad(depth + 2)}<img class="photo" src="${escapeAttr(mainPhoto)}"${mainSized} alt="${alt}" width="900" height="600" ` +
    `loading="eager" fetchpriority="high" decoding="async">`,
    `${pad(depth + 1)}</button>`,
  ];

  // 1 photo — no thumbnail row: there is nothing to switch to, but it can still
  // be opened full screen.
  if (!rest.length)
    return [`${pad(depth)}<div class="gallery"${nav}>`, ...mainLines,
            `${pad(depth)}</div>`].join("\n");

  // Thumbnails for ALL photos, the first one included: otherwise there is no way
  // back to it after switching.
  const thumbSized = await Promise.all(working.map((url) => sizedAttrs(url, THUMB_WIDTHS, THUMB_SIZES)));
  // data-full — the width set of THIS photo for the large frame, not for the
  // thumbnail. The script has nowhere else to get it: the markup holds only the
  // first photo's set, and a thumbnail's set is a hundred points wide and would
  // be mush in the large frame.
  const thumbFull = await Promise.all(working.map((url) => sizedSrcset(url, MAIN_WIDTHS)));
  const thumbnailLines = working.flatMap((url, i) => [
    `${pad(depth + 2)}<li>`,
    `${pad(depth + 3)}<button class="gallery__thumb${i === 0 ? " is-active" : ""}" type="button"` +
      `${thumbFull[i] ? ` data-full="${escapeAttr(thumbFull[i])}"` : ""}>`,
    `${pad(depth + 4)}<img class="photo" src="${escapeAttr(url)}"${thumbSized[i]} alt="${alt}" width="300" height="200" ` +
    `loading="lazy" decoding="async">`,
    `${pad(depth + 3)}</button>`,
    `${pad(depth + 2)}</li>`,
  ]);

  return [
    `${pad(depth)}<div class="gallery"${nav}>`,
    ...mainLines,
    `${pad(depth + 1)}<ul class="gallery__thumbs">`,
    ...thumbnailLines,
    `${pad(depth + 1)}</ul>`,
    `${pad(depth)}</div>`,
  ].join("\n");
}

function buildBuy(car: Car, text: Values, data: Values, page: string, bookingUrl: string, depth: number): string {
  const ladder = steps(car.tariffs ?? {});

  // data-from on each step — the script highlights the one that applies to the
  // chosen term by it. Without the script this is simply a price list, as it
  // always was: the attribute changes nothing.
  const rows = ladder.flatMap((step) => [
    `${pad(depth + 2)}<div class="tariffs__row" data-from="${step.from}">`,
    `${pad(depth + 3)}<dt class="muted small">${escape(label(step))}</dt>`,
    `${pad(depth + 3)}<dd class="price"><span class="price__value">$${step.price}</span></dd>`,
    `${pad(depth + 2)}</div>`,
  ]);

  // Delivery options. Handover and return are counted separately, so the price
  // here is for ONE leg: around Batumi and to the airport it is per car (from the
  // database), Kutaisi and Tbilisi are the same for everyone (from data.txt).
  const free = word(text, "calc-free", page);
  const places: Array<[string, number | null]> = [
    // "No delivery" comes first: the client collects the car themselves, that is
    // a zero on the bill and the reference point for the other options. Being
    // first, it is also the default, and the calculator shows the price without
    // delivery.
    ["place-none", 0],
    ["place-city", car.delivery_city_usd ?? null],
    ["place-airport", car.delivery_airport_usd ?? null],
    ["place-kutaisi", Number(data["delivery-kutaisi"])],
    ["place-tbilisi", Number(data["delivery-tbilisi"])],
  ];

  function placeOptions(indent: number): string[] {
    const out: string[] = [];
    for (const [key, sum] of places) {
      if (sum == null) continue;
      out.push(pad(indent) + `<option value="${sum}">` +
               escape(word(text, key, page)) + " — " + escape(sum === 0 ? free : "$" + sum) + "</option>");
    }
    // An empty value means "nothing to compute": this leg does not go into the
    // total, and a note under the calculator says the manager will quote it.
    out.push(pad(indent) + `<option value="">${escape(word(text, "place-other", page))}</option>`);
    return out;
  }

  function placeField(labelKey: string, cls: string, indent: number): string[] {
    return [
      pad(indent) + `<label class="calc__field">`,
      pad(indent + 1) + `<span class="muted small">${escape(word(text, labelKey, page))}</span>`,
      pad(indent + 1) + `<select class="${cls}">`,
      ...placeOptions(indent + 2),
      pad(indent + 1) + `</select>`,
      pad(indent) + `</label>`,
    ];
  }

  const depositNote = car.deposit_usd == null || car.deposit_usd === 0 ? [] : [
    `${pad(depth + 2)}<p class="small muted calc__deposit">` +
      `${escape(word(text, "calc-deposit", page).replace("#", `$${car.deposit_usd}`))}</p>`,
  ];

  // The starting term is where the second step begins, if there is one: on a
  // single day there is no discount to see, and the discount is exactly what
  // people come here to look at.
  const startDays = ladder.length > 1 ? ladder[1].from : 1;

  // Everything the script needs is in attributes: the ladder as numbers, the
  // phone and the WhatsApp text. The script knows not one word of any language —
  // it only substitutes numbers, so there is nothing in it to translate.
  const stepsJson = JSON.stringify(ladder.map((s) => [s.from, s.price]));
  const message = word(text, "wa-text", page).replace("#", `${car.brand} ${car.model} ${car.year}`);

  // Two separate blocks rather than one: the price list is a reference — "what a
  // day costs"; the calculator is an answer — "what will it come to for me".
  // Different questions, and on a wide screen they stand side by side as two
  // columns. Both are returned as one string because in the template they are
  // neighbours inside .car-top.
  return [
    `${pad(depth)}<div class="tariffs frame">`,
    `${pad(depth + 1)}<p class="tariffs__title">${escape(word(text, "tariffs-title", page))}</p>`,
    `${pad(depth + 1)}<dl class="tariffs__list">`,
    ...rows,
    `${pad(depth + 1)}</dl>`,
    `${pad(depth)}</div>`,
    "",
    `${pad(depth)}<div class="buy">`,
    `${pad(depth + 1)}<div class="calc frame"`,
    `${pad(depth + 2)}data-steps="${escapeAttr(stepsJson)}"`,
    `${pad(depth + 2)}data-start="${startDays}"`,
    `${pad(depth + 2)}data-phone="${escapeAttr(data["whatsapp"])}"`,
    `${pad(depth + 2)}data-message="${escapeAttr(message)}"`,
    `${pad(depth + 2)}data-days-text="${escapeAttr(word(text, "wa-days", page))}">`,
    "",
    `${pad(depth + 2)}<p class="calc__title">${escape(word(text, "calc-title", page))}</p>`,
    "",
    `${pad(depth + 2)}<label class="calc__field">`,
    `${pad(depth + 3)}<span class="muted small">${escape(word(text, "calc-days", page))}</span>`,
    `${pad(depth + 3)}<input class="calc__days" type="number" min="1" max="90" step="1"`,
    `${pad(depth + 4)}value="${startDays}" inputmode="numeric">`,
    `${pad(depth + 2)}</label>`,
    "",
    ...placeField("calc-pickup", "calc__pickup", depth + 2),
    "",
    ...placeField("calc-return", "calc__return", depth + 2),
    "",
    `${pad(depth + 2)}<dl class="calc__list">`,
    `${pad(depth + 3)}<div class="calc__row">`,
    `${pad(depth + 4)}<dt class="muted small">${escape(word(text, "calc-rent", page))}</dt>`,
    `${pad(depth + 4)}<dd class="calc__rent"></dd>`,
    `${pad(depth + 3)}</div>`,
    `${pad(depth + 3)}<div class="calc__row calc__row--discount" hidden>`,
    `${pad(depth + 4)}<dt class="muted small">${escape(word(text, "calc-discount", page))}</dt>`,
    `${pad(depth + 4)}<dd class="calc__discount"></dd>`,
    `${pad(depth + 3)}</div>`,
    `${pad(depth + 3)}<div class="calc__row calc__row--delivery" hidden>`,
    `${pad(depth + 4)}<dt class="muted small">${escape(word(text, "calc-delivery", page))}</dt>`,
    `${pad(depth + 4)}<dd class="calc__delivery"></dd>`,
    `${pad(depth + 3)}</div>`,
    `${pad(depth + 2)}</dl>`,
    "",
    `${pad(depth + 2)}<div class="calc__total">`,
    `${pad(depth + 3)}<p class="muted small">${escape(word(text, "calc-total", page))}</p>`,
    `${pad(depth + 3)}<p class="price"><span class="price__value calc__total-value"></span></p>`,
    `${pad(depth + 2)}</div>`,
    "",
    ...depositNote,
    `${pad(depth + 1)}</div>`,
    "",
    `${pad(depth + 1)}<a class="btn btn--wide calc__book" href="${bookingUrl}" rel="noopener">${escape(word(text, "cta", page))}</a>`,
    `${pad(depth + 1)}<p class="small muted calc__note">${escape(word(text, "calc-note", page))}</p>`,
    // The disclaimer that the estimate is provisional: the figure on screen is
    // computed from the tariff ladder, but the manager names the final sum.
    `${pad(depth + 1)}<p class="small muted calc__legal">${escape(word(text, "calc-legal", page))}</p>`,
    `${pad(depth)}</div>`,
  ].join("\n");
}

/** The terms for this car. Deposit / age / experience / mileage / insurance — the
    row is skipped when the field is not filled in (as everywhere in this project:
    an empty field means no row, not an em dash). cross_border is the exception:
    we show both "allowed" and "forbidden" — that is a definite rental condition,
    not a spec whose null means "unknown". */
function buildCarTerms(car: Car, lang: Lang, text: Values, page: string, depth: number): string {
  const rows: string[] = [];
  // depth + 2, not + 1: <div class="row"> sits INSIDE <dl class="rows">, and that
  // already stands at depth + 1 — the row has to be one level deeper still.
  const row = (dt: string, dd: string) =>
    rows.push(
      `${pad(depth + 2)}<div class="row">`,
      `${pad(depth + 3)}<dt>${escape(dt)}</dt>`,
      `${pad(depth + 3)}<dd class="muted">${dd}</dd>`,
      `${pad(depth + 2)}</div>`,
    );

  // As in the price block: 0 means "no deposit", null means there is no row.
  if (car.deposit_usd != null)
    row(word(text, "deposit-title", page),
        car.deposit_usd === 0 ? escape(word(text, "deposit-none", page)) : `$${car.deposit_usd}`);

  if (car.min_driver_age != null)
    row(word(text, "terms-min-age", page),
        escape(word(text, `age-from-${plural(lang, car.min_driver_age)}`, page).replace("#", String(car.min_driver_age))));

  if (car.min_experience_y != null)
    row(word(text, "terms-experience", page),
        escape(word(text, `experience-from-${plural(lang, car.min_experience_y)}`, page).replace("#", String(car.min_experience_y))));

  if (car.mileage_limit_km == null) {
    row(word(text, "terms-mileage", page), escape(word(text, "mileage-unlimited", page)));
  } else {
    const parts = [escape(word(text, "mileage-per-day", page).replace("#", String(car.mileage_limit_km)))];
    if (car.mileage_free_from_days != null)
      parts.push(escape(word(text, "mileage-free-from", page).replace("#", String(car.mileage_free_from_days))));
    row(word(text, "terms-mileage", page), parts.join("<br>"));
  }

  if (car.insurance) row(word(text, "terms-insurance", page), escape(word(text, `insurance-${car.insurance}`, page)));

  // 0 → "free", null → no row at all, a number → "$N". Each row (city/airport) is
  // decided independently: one can be free and the other paid on the same car.
  if (car.delivery_city_usd != null)
    row(word(text, "terms-delivery-city", page),
        car.delivery_city_usd === 0 ? escape(word(text, "delivery-free", page)) : `$${car.delivery_city_usd}`);
  if (car.delivery_airport_usd != null)
    row(word(text, "terms-delivery-airport", page),
        car.delivery_airport_usd === 0 ? escape(word(text, "delivery-free", page)) : `$${car.delivery_airport_usd}`);

  if (car.cross_border != null)
    row(word(text, "terms-cross-border", page),
        escape(word(text, car.cross_border ? "cross-border-allowed" : "cross-border-forbidden", page)));

  if (!rows.length) return "";

  return [
    `${pad(depth)}<section class="block">`,
    `${pad(depth + 1)}<h2 class="block__title">${escape(word(text, "car-terms-title", page))}</h2>`,
    `${pad(depth + 1)}<dl class="rows">`,
    ...rows,
    `${pad(depth + 1)}</dl>`,
    "",
    `${pad(depth + 1)}<p class="small muted list-note">${escape(word(text, "terms-note", page))}</p>`,
    `${pad(depth)}</section>`,
  ].join("\n");
}

/** Assemble one car's page in one language — entirely as a string, reading and
    writing nothing on disk. Comparing it with what is in www/, and the writing
    itself, are the caller's business (render() below). */
/** Structured data for a car page: the car itself, and the trail leading to it.

    Everything claimed here is already on the page in words — the same make, the
    same specifications out of the same dictionary, the same "from $42" off the
    same ladder, the same photographs through livePhotos(). That is the whole
    rule for this kind of markup: it restates what a visitor sees, it never adds
    to it. Claim what the page does not show and a search engine is entitled to
    throw the lot away, including the honest half.

    Both objects travel under one @graph rather than in two script tags: one
    block in the head, one place to look when something reads wrong. */
async function buildStructuredData(car: Car, lang: Lang, text: Values, data: Values,
                                   page: string): Promise<string> {
  const domain = data["domain"].replace(/\/+$/, "");
  const home = `${domain}/${lang}/`;
  const here = `${home}cars/${car.slug}/`;
  const name = `${car.brand} ${car.model} ${car.year}`;
  const photos = await livePhotos(car, data);
  const from = car.tariffs ? minPrice(car.tariffs) : 0;

  return jsonLd({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Car",
        "@id": here + "#car",
        name,
        url: here,
        brand: { "@type": "Brand", name: car.brand },
        model: car.model,
        vehicleModelDate: String(car.year),
        // The same guards as SPEC_FIELDS above, and deliberately the same
        // dictionary keys: the value in the markup is the word printed in the
        // specifications table, in the language of the page.
        bodyType: car.body ? word(text, `body-${car.body}`, page) : undefined,
        vehicleTransmission: car.transmission ? word(text, `trans-${car.transmission}`, page) : undefined,
        fuelType: car.fuel ? word(text, `fuel-${car.fuel}`, page) : undefined,
        driveWheelConfiguration: car.drive ? word(text, `drive-${car.drive}`, page) : undefined,
        vehicleSeatingCapacity: car.seats ?? undefined,
        numberOfDoors: car.doors ?? undefined,
        vehicleEngine: car.engine_l != null
          ? { "@type": "EngineSpecification",
              engineDisplacement: { "@type": "QuantitativeValue", value: car.engine_l, unitCode: "LTR" } }
          : undefined,
        image: photos.length ? photos : undefined,
        // No ladder, no offer: a price of zero would be a lie, and an offer
        // without a price is rejected anyway.
        offers: from > 0 ? {
          "@type": "Offer",
          url: here,
          availability: "https://schema.org/InStock",
          priceCurrency: "USD",
          // The bottom rung — the same number the card and the price block
          // print as "from".
          price: from,
          // Said twice on purpose: price alone reads as the cost of the car,
          // and this is the cost of a DAY of it. UN/CEFACT calls a day "DAY".
          priceSpecification: {
            "@type": "UnitPriceSpecification",
            priceCurrency: "USD",
            price: from,
            unitCode: "DAY",
          },
        } : undefined,
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1,
            name: `${data["brand-1"]} ${data["brand-2"]}`, item: home },
          { "@type": "ListItem", position: 2,
            name: word(text, "nav-cars", page), item: home + "cars/" },
          // The last rung carries no address: it is the page being read.
          { "@type": "ListItem", position: 3, name },
        ],
      },
    ],
  });
}

async function buildPage(car: Car, lang: Lang, ctx: BlocksContext, page: string): Promise<string> {
  const text = ctx.texts[lang];
  const template = readFileSync(TEMPLATE_PATH, "utf8");

  const name = `${car.brand} ${car.model}`;
  const nameAndYear = `${name} ${car.year}`;

  const message = word(text, "wa-text", page).replace("#", nameAndYear);
  const bookingUrl = `https://wa.me/${ctx.data["whatsapp"]}?text=${encodeURIComponent(message)}`;

  const chips: string[] = [];
  if (car.class) chips.push(word(text, `class-${car.class}`, page));
  if (car.transmission) chips.push(word(text, `trans-${car.transmission}`, page));
  if (car.seats) chips.push(`${car.seats} ${word(text, "seats-" + plural(lang, car.seats), page)}`);

  const values: Values = {
    ...publicData(ctx.data),
    ...text,
    "car-name": escape(name),
    "car-year": String(car.year),
    // A hash, not {tokens}: the same trick already used by
    // price-from/photo-alt/wa-text — one mechanism across the project for
    // "template plus one substitution".
    //
    // escape() on car-title and escapeAttr() on car-meta are not the same
    // escaping applied by mistake: <title> is a text node (escape() is enough),
    // while car-meta goes into meta content="…", an attribute, which also needs
    // &quot; on a quote. Without that, a brand containing &, <, > or " in the
    // database breaks <title>/content in all three languages of that car.
    "car-title": escape(word(text, "car-title", page).replace("#", nameAndYear)),
    "car-meta": escapeAttr(word(text, "car-meta", page).replace("#", nameAndYear)),
    "chips": chips.map((c) => `          <li class="chip">${escape(c)}</li>`).join("\n"),
    // The depth is exactly where the {token} itself sits in templates/car.html:
    // 8 spaces for {gallery}/{buy} inside .car-top, the same for the other three
    // inside .blocks. Change the nesting in the template and change it here too,
    // otherwise the indentation in the finished page drifts apart.
    "gallery": await buildGallery(car, text, ctx.data, page, 4),
    "buy": buildBuy(car, text, ctx.data, page, bookingUrl, 4),
    "description": buildDescription(car, lang, text, page, 4),
    "panels": buildPanels(car, ctx.texts, lang, page, 4),
    "car-terms": buildCarTerms(car, lang, text, page, 4),
    "booking-url": bookingUrl,
  };

  // Simple {tokens} in one general pass, with the same substitute() used on
  // blocks/*.html. fillBlocks() then resolves what depends on the page's path
  // (url-cars, url-ru/en/ka, alternates, fontpreload) and pours in the header,
  // footer and <head> — the page is never without them for a second.
  let html = substitute(template, values);
  html = fillBlocks(html, join(ROOT, page), ctx, {
    jsonld: await buildStructuredData(car, lang, text, ctx.data, page),
  });

  const leftover = [...new Set([...html.matchAll(/\{([a-z0-9-]+)\}/g)].map((m) => m[1]))];
  if (leftover.length)
    throw new Error(`${page}: unfilled {tokens} left over — ` +
                    leftover.map((k) => `{${k}}`).join(", "));

  return html;
}

/** Checking one car for complete content. An empty description string in any
    language, or an empty price ladder, means we skip ALL three languages of that
    car at once (not only the one with the hole): otherwise the page exists in two
    languages while the third's hreflang points at a 404 — a direct violation of
    the rule that a page must exist in all three, or Google stops trusting the
    whole set. An already published page is not touched in the process — we simply
    do not update it until the content is fixed. */
function contentIssues(car: Car): string[] {
  const issues: string[] = [];
  for (const lang of LANGS)
    if (!car.content?.[lang]?.description) issues.push(`no description in language "${lang}"`);
  if (!car.tariffs || !Object.keys(car.tariffs).length) issues.push("empty price ladder (tariffs)");
  return issues;
}

/** Cleaning up orphaned www/<lang>/cars/<slug>/ folders when the slug is no
    longer in the active set (every car with a valid slug — regardless of whether
    a page could be assembled for it: a temporary hole in the content must not
    read as "the car is gone" and take down an already published page). */
/** It prints as it goes — that way every folder left in place gets the right
    reason. There used to be one shared pass after returning from the function:
    if the safety catch tripped it still deleted nothing, but it labelled every
    candidate "does not look like something this script generated" — a lie for
    those whose fingerprint is right where it should be, and precisely at the
    moment a person needs to understand what happened to the database rather than
    delete perfectly fine folders by hand. Now the decision "not touching it" has
    two different causes, each with its own message: the general threshold tripped
    (one summary line and a list, with no per-folder verdict), or this particular
    folder is not ours (per folder, as before). */
function cleanupLang(lang: Lang, activeSlugs: Set<string>): string[] {
  const carsDir = join(ROOT, "www", lang, "cars");
  if (!existsSync(carsDir)) return [];

  const entries = readdirSync(carsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const candidates = entries.filter((e) => !activeSlugs.has(e.name));
  if (!candidates.length) return [];

  // A safety catch against mass deletion: a database failure or a bug in the
  // filter must not wipe out half the fleet in a single run. One cause — one
  // message: nothing is known about any individual folder here, and there is no
  // point pretending otherwise.
  if (candidates.length > 2 && candidates.length > entries.length / 2) {
    console.log(`⚠ ${lang}/cars: ${candidates.length} of ${entries.length} folders came up for deletion — ` +
                "suspiciously many, touching nothing. Check the database by hand:");
    for (const e of candidates) console.log(`    ${lang}/cars/${e.name}/`);
    return [];
  }

  const removed: string[] = [];
  for (const entry of candidates) {
    const dir = join(carsDir, entry.name);
    const files = readdirSync(dir).filter((f) => f !== ".DS_Store");
    const isOwn = files.length === 0 ||
      (files.length === 1 && files[0] === "index.html" &&
       readFileSync(join(dir, "index.html"), "utf8").startsWith(FINGERPRINT));

    if (isOwn) {
      rmSync(dir, { recursive: true, force: true });
      removed.push(`${lang}/cars/${entry.name}/`);
      console.log(`  • ${lang}/cars/${entry.name}/ removed — there is no car with that slug any more`);
    } else {
      console.log(`  ⚠ ${lang}/cars/${entry.name}/ looks like a car page but does not look like one ` +
                  "generated by this script — not touching it, check and delete it by hand");
    }
  }
  return removed;
}

/** Lay the cars out across the pages. Returns the list of files touched.
    Separate from main() — the watcher in server.ts does the same thing. */
export async function render(cars: Car[], data: Values = readData()): Promise<string[]> {
  if (!existsSync(TEMPLATE_PATH))
    throw new Error("could not find templates/car.html");

  const { texts, blocks } = loadContext();
  const ctx: BlocksContext = { data, texts, blocks };

  // A structural check — the key is missing for every car in every language.
  // That is somebody else's configuration error, like a broken data.txt: throw
  // stops the whole run rather than quietly spoiling all thirty pages at once.
  for (const lang of LANGS)
    for (const key of ["car-title", "car-meta"])
      if (!(key in texts[lang]))
        throw new Error(`text/${lang}.txt has no "${key}" key — without it not a single car page can be built`);

  const changed: string[] = [];
  const activeSlugs = new Set<string>();
  const ready: Car[] = [];

  for (const car of cars) {
    if (!SLUG_OK.test(car.slug)) {
      console.log(`✖ ${car.brand} ${car.model} ${car.year} (id ${car.id}): slug "${car.slug}" — ` +
                  "characters that are not allowed, page not created");
      continue;
    }
    activeSlugs.add(car.slug);

    const issues = contentIssues(car);
    if (issues.length) {
      console.log(`✖ ${car.brand} ${car.model} ${car.year} (slug ${car.slug}): ${issues.join("; ")} — ` +
                  "not writing this car's pages in any language until it is fixed");
      continue;
    }
    ready.push(car);
  }

  for (const car of ready) {
    for (const lang of LANGS) {
      const page = `www/${lang}/cars/${car.slug}/index.html`;
      const path = join(ROOT, page);

      const html = await buildPage(car, lang, ctx, page);

      mkdirSync(join(ROOT, "www", lang, "cars", car.slug), { recursive: true });
      const before = existsSync(path) ? readFileSync(path, "utf8") : null;
      if (html !== before) {
        writeFileSync(path, html, "utf8");
        changed.push(page);
      }
    }
  }

  // First we write and update the active pages, and only then clear away the
  // orphans — when a slug is renamed the car is never invisible for a single
  // second. cleanupLang() prints for itself — the decision "not touching it" has
  // two different causes with two different messages (see the comment above the
  // function), and there is no point gluing them back into one pass here.
  for (const lang of LANGS) cleanupLang(lang, activeSlugs);

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
    fail("the database returned zero cars — there is nothing to build car pages from");

  console.log(`Cars in the database: ${cars.length}`);

  let changed: string[];
  try {
    changed = await render(cars, data);
  } catch (error) {
    return fail((error as Error).message);
  }

  if (changed.length) {
    console.log(`Car pages updated: ${changed.length}`);
    for (const page of changed) console.log(`  • ${page}`);
  } else {
    console.log("Nothing to update — everything already matches.");
  }
}

// Run directly (node car-pages.ts) — do the work. Imported from server.ts — stay quiet.
if (process.argv[1] && import.meta.filename === process.argv[1]) await main();
