/*
  lib/tariffs.ts — everything to do with the price ladder.

  It sits in its own file for exactly one reason: this arithmetic has more than
  one caller. Coming next are the date calculator in the browser ("picked 5 days
  — show me the total") and the server function that accepts a booking. Three
  money calculations in three places drift apart sooner or later, so there is
  one calculation and it lives here. Nothing in this file touches the disk or
  the network — that way it can be handed to the browser as it is.

  The ladder arrives from the database looking like this:

      { "1": 65, "2": 58, "3": 55, "4": 49, "8": 46 }

  The key is the rental day the price starts to apply from, the value is the
  price per day. The upper bound is not stored: a step ends where the next one
  begins. The last step goes on with no limit on the term.
*/

export type Tariffs = Record<string, number>;

export type Step = {
  from: number;      // the day it starts to apply
  to: number | null; // the last day it covers; null means "and onwards"
  price: number;     // price per day
};

/** A step's price as a number. null means the database holds something else.

    The tariffs column is jsonb: the database does not check the type of the
    value, so a string, a null or anything at all can land there. Previously
    only the KEY (the day) was checked and the value went into the markup as
    it was — as a string in the price list text and, worse, in the calculator's
    data-steps attribute, where a quote could break out of it. Number("") gives
    0, so the empty string is rejected separately. */
function priceAt(tariffs: Tariffs, day: number): number | null {
  const raw = tariffs[String(day)];
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** The ladder in order, with the upper bounds filled in. */
export function steps(tariffs: Tariffs): Step[] {
  const days = Object.keys(tariffs)
    .map(Number)
    .filter((d) => Number.isInteger(d) && d > 0 && priceAt(tariffs, d) !== null)
    .sort((a, b) => a - b);

  return days.map((from, i) => ({
    from,
    to: i + 1 < days.length ? days[i + 1] - 1 : null,
    price: priceAt(tariffs, from)!,
  }));
}

/** The lowest price on the ladder — the one a card shows as "from". */
export function minPrice(tariffs: Tariffs): number {
  // Through steps() rather than Object.values(): this way the "from $…" on the
  // card is computed from the same validated steps as the price list, and a
  // string in place of a price cannot drag the minimum into NaN.
  const prices = steps(tariffs).map((step) => step.price);
  return prices.length ? Math.min(...prices) : 0;
}

/** The per-day price for a rental of this many days. */
export function priceForDays(tariffs: Tariffs, days: number): number {
  let matched = 0;
  for (const step of steps(tariffs)) if (days >= step.from) matched = step.price;
  return matched;
}

/** What a rental of this many days costs in total. */
export function total(tariffs: Tariffs, days: number): number {
  return priceForDays(tariffs, days) * days;
}

/** A step's label: "1", "3–7", "8+". There are deliberately no words —
    they differ across the three languages, while the digits do not. */
export function label(step: Step): string {
  if (step.to === null) return `${step.from}+`;
  if (step.to === step.from) return String(step.from);
  return `${step.from}–${step.to}`;
}
