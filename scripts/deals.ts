/*
  deals.ts — takes the deals from the database and lays them out across the
  "Deals" pages, in all three languages.

  What it fills
      <!--@event-deals-->   the list of event deals

  Where it takes things from
      data.txt              database address and key
      event_deals table     the deals themselves

  Event deals are discounts not tied to a car: birthdays, holidays, the season.
  Discounts on specific cars will come from car_deals — that is the next table
  and the second marker on the same page.

  The text in the circle is the badge column: whatever you write is what shows
  up — "−15%", "20$", "24/7". Leave it empty and there is no circle.

  The rule "discounts do not stack, tell the manager" is written straight into
  the page: it is the same for every deal, and it has no business in the database.

  Only deals with the is_active flag are shown.

  Run:   node deals.ts
*/

import { LANGS, fail, readData, fetchRows, fillMarkers, escape,
         type Lang, type Values } from "../lib/site.ts";

const FIELDS = "slug,badge,content";

type Deal = {
  slug: string;
  badge: string | null;
  content: Record<string, { title?: string; text?: string; badge?: string }> | null;
};

export async function fetchDeals(data: Values = readData()): Promise<Deal[]> {
  return await fetchRows<Deal>(data, "event_deals", FIELDS);
}

/** Every sentence on its own line — the same as on the other pages.

    The boundary is a period followed by whitespace. A period inside a number
    ($0.20, 10.5) has no space after it, so numbers do not get torn apart.
    We escape after splitting: <br> has to stay a tag, not become text. */
function sentencesToLines(text: string, indent: string): string {
  return text.trim().split(/(?<=\.)\s+/).map(escape).join(`<br>\n${indent}`);
}

export async function render(deals: Deal[]): Promise<string[]> {
  const changed: string[] = [];

  for (const lang of LANGS) {
    const page = `www/${lang}/deals/index.html`;

    const items = deals.map((deal) => {
      const entry = deal.content?.[lang];
      if (!entry?.title || !entry?.text)
        // throw, not fail(): render() is poked by the watcher in server.ts every
        // 10 seconds — process.exit() here would mean one unfilled deal takes
        // down the whole server.
        throw new Error(`deal "${deal.slug}": no title or description in language "${lang}". ` +
             "Fill the content column in all three languages, otherwise the page comes out full of holes");

      // The text in the circle is usually the same in every language: "−10%",
      // "$20" — there is nothing to translate. But when words end up in it
      // ("$90 per day"), it goes into content next to the title, one per
      // language. Whatever the translation holds wins; otherwise the shared
      // badge column is used.
      const badge = (entry.badge ?? deal.badge ?? "").trim();

      // The circle is optional: empty simply means no such line in the markup,
      // and the deal keeps its title and description.
      const badgeHtml = badge ? `\n          <p class="deal__badge">${escape(badge)}</p>` : "";

      return `        <li class="deal frame">${badgeHtml}
          <h2>${escape(entry.title)}</h2>
          <p class="muted">${sentencesToLines(entry.text, " ".repeat(10))}</p>
        </li>`;
    });

    if (fillMarkers(page, { "event-deals": items.join("\n") }, "deals")) changed.push(page);

    // Deals also show on the home page — the marker there is the same one.
    const home = `www/${lang}/index.html`;
    if (fillMarkers(home, { "event-deals": items.join("\n") }, "deals")) changed.push(home);
  }
  return changed;
}

async function main(): Promise<void> {
  let deals: Deal[];
  try {
    deals = await fetchDeals();
  } catch (error) {
    return fail((error as Error).message);
  }

  if (!deals.length) {
    console.log("No deals with the is_active flag in the database — the page will be empty.");
  } else {
    console.log(`Deals with the is_active flag: ${deals.length}`);
    for (const deal of deals)
      console.log(`  • ${(deal.badge ?? "—").padStart(6)}  ${deal.content?.ru?.title ?? deal.slug}`);
  }

  // render() can now throw an Error (a missing deal translation) — caught right
  // here: the output of a one-off run stays as it was, and the watcher in
  // server.ts gets the same exception through its own try/catch.
  let changed: string[];
  try {
    changed = await render(deals);
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

// Run directly — do the work. Imported from server.ts — stay quiet.
if (process.argv[1] && import.meta.filename === process.argv[1]) await main();
