/** Small formatting helpers shared by the HUD. */

/**
 * Escapes text before it goes into innerHTML.
 *
 * Display names and chat messages are player-supplied. The server strips
 * control characters and enforces a character class on names, but chat is free
 * text -- so every player-supplied string is escaped here at the point of use,
 * rather than trusting an upstream filter.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 1234 -> "1,234"; 1234567 -> "1.2M" so the wallet never overflows its panel. */
export function formatNumber(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (Math.abs(number) >= 100_000) return `${Math.round(number / 1000)}K`;
  return number.toLocaleString('en-US');
}

/**
 * A Gold figure as the appraiser's dollar quote: 37 -> "$3.70", 10000 -> "$1,000".
 *
 * Cents only below $100, where they are the difference between two stones; a
 * four-figure Amethyst quote does not need them and reads worse with them.
 * `rate` is dollars per Gold and comes from the catalog, so the panel and the
 * server's own tier table can never drift apart.
 */
export function formatDollars(gold, rate) {
  const dollars = (Number(gold) || 0) * (Number(rate) || 0);
  const cents = dollars < 100 && !Number.isInteger(dollars);
  return `$${dollars.toLocaleString('en-US', {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })}`;
}

/**
 * A probability as odds: 0.00826 -> "1 in 121", 0.226 -> "1 in 4.4".
 *
 * Odds rather than a percentage because that is the form the number is
 * actually asked in. "0.05%" and "0.005%" are two shrugs; "1 in 2,000" and
 * "1 in 20,000" are a decision. The difference only grows at the rare end,
 * which is exactly the end a chest panel is about.
 *
 * One decimal below 1 in 10, where the gap between 1 in 4 and 1 in 4.4 is a
 * fifth of the wait and rounding it away would misstate the common case; a
 * whole number above it, where a decimal is noise.
 *
 * Three significant figures past a thousand: the arithmetic behind a
 * 1-in-194,024 is exact, but printing it to the unit implies a precision the
 * *game* does not have -- a real rate moves with tackle and with the fish that
 * drops the chest. "1 in 194,000" claims only what it can support.
 */
export function formatOdds(probability) {
  const p = Number(probability);
  if (!Number.isFinite(p) || p <= 0) return 'never';
  if (p >= 1) return 'always';

  const one = 1 / p;
  if (one < 10) return `1 in ${one.toFixed(1)}`;
  if (one < 1000) return `1 in ${Math.round(one)}`;

  const step = 10 ** (Math.floor(Math.log10(one)) - 2);
  return `1 in ${(Math.round(one / step) * step).toLocaleString('en-US')}`;
}

/**
 * A span of milliseconds as a rounded phrase: "3 minutes", "about 2 hours".
 *
 * Deliberately coarse. This is only used to tell a player how long they were
 * away for, where "about 2 hours" is the whole of what they want to know and a
 * figure to the second would read as a stopwatch pointed at them.
 */
export function formatDuration(ms) {
  const minutes = Math.round((Number(ms) || 0) / 60_000);
  if (minutes < 2) return 'a minute or so';
  if (minutes < 60) return `${minutes} minutes`;

  const hours = Math.round(minutes / 60);
  return hours < 2 ? 'about an hour' : `about ${hours} hours`;
}

/** Server timestamps are epoch ms; chat shows local wall-clock time. */
export function formatTime(at) {
  const date = new Date(Number(at) || Date.now());
  if (Number.isNaN(date.getTime())) return '--:--';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
