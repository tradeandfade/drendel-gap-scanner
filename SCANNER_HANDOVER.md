# Scanner handover: "Ugly close → gap up" filter parameters

## Context for the receiving Claude Code session

The user has an existing real-time scanner web app that watches a universal
watchlist. They want to add two filter parameters borrowed from a separate
backtesting project (`UglyCloseGapUp`) where the math is already validated.

The pattern in plain English:
1. **Day 1 ("ugly close")** — the stock closes weakly, in the lower part of
   that day's high-low range.
2. **Day 2 ("gap up")** — the next session opens at or above some target level
   inside Day 1's range, signaling overnight buyers willing to pay up.

This document specifies exactly how to quantify each threshold, the math, edge
cases, and how to wire them into a live scanner. It does **not** prescribe a
tech stack or UI — adapt the formulas to whatever the existing scanner uses.

---

## The two parameters

### 1. `closePct` — Day 1 weakness threshold

**Definition:** The Day 1 close, expressed as a percentage of the way from
Day 1's low to Day 1's high. A signal fires only if the close is at or below
this percentage.

**Formula:**

```
d1_range = d1.high - d1.low
cl       = (d1.close - d1.low) / d1_range     // 0.0 → closed at low, 1.0 → closed at high
                                              // expressed as 0–1; multiply by 100 for %
trigger  = cl <= (closePct / 100)
```

**Bounds:**
- `closePct` is in **percent**, range `0` to `100`.
- A LOWER value is STRICTER (only the very weakest closes qualify).
- A HIGHER value is LOOSER (more closes qualify).

**Examples (closePct = 25):**

| d1.low | d1.high | d1.close | range | cl     | passes? |
|--------|---------|----------|-------|--------|---------|
| 100    | 110     | 101      | 10    | 0.10   | ✓ (10% ≤ 25%) |
| 100    | 110     | 102.5    | 10    | 0.25   | ✓ (exactly at threshold) |
| 100    | 110     | 105      | 10    | 0.50   | ✗ (mid-range close) |
| 100    | 110     | 100      | 10    | 0.00   | ✓ (closed at the low) |

**Recommended default:** `25` (close in bottom 25% of range). The user's
backtester defaults to this.

**Suggested slider range for UI:** `5` to `50` in increments of `5`.

### 2. `gapPct` — Day 2 gap-up threshold

**Definition:** Day 2's opening price, expressed as a percentage of the way
from Day 1's low to Day 1's high. A signal fires only if the open is at or
above this percentage.

**Formula:**

```
d1_range = d1.high - d1.low
gl       = (d2.open - d1.low) / d1_range
trigger  = gl >= (gapPct / 100)
```

**Bounds:**
- `gapPct` is in **percent**, range `0` to ~`200` (gaps above Day 1's high
  are valid and produce values > 100).
- A HIGHER value is STRICTER (only stronger gaps qualify).
- A LOWER value is LOOSER.

**Critical nuance:** This is **NOT** "gap up X% above the prior close." It is
"open at or above the X% level inside Day 1's range." A `gapPct` of 50 means
"opens at or above the midpoint of Day 1's range" — it does NOT mean "opens
50% above yesterday's close."

**Examples (gapPct = 50, with d1.low=100, d1.high=110, range=10):**

| d2.open | gl    | passes? | interpretation |
|---------|-------|---------|----------------|
| 99      | -0.10 | ✗       | gapped DOWN below D1.low |
| 100     | 0.00  | ✗       | opened at D1.low |
| 105     | 0.50  | ✓       | opened at the midpoint of D1's range |
| 110     | 1.00  | ✓       | opened exactly at D1's high |
| 115     | 1.50  | ✓       | opened above D1's high (strong gap) |

**Recommended default:** `50` (open at or above D1 midpoint). The user's
backtester defaults to this.

**Suggested slider range for UI:** `0` to `150` in increments of `5`.

### Why both thresholds use D1's range as the denominator

The point of the pattern is to identify a 2-day reversal: weak close into
strength. Normalizing both numerators by `d1_range` puts both on the same
scale, so they're directly comparable. A close at 20% and an open at 80%
means the stock traded the entire bottom-fifth of the range on D1 and then
gapped to the top-fifth on D2 — a coherent definition of "rejection of the
weakness."

---

## How to use the parameters in a live scanner

The scanner runs in two passes against the user's universal watchlist:

### Pass A: After the close on day N (the "ugly close" pass)

Inputs needed per ticker:
- `d1.high`, `d1.low`, `d1.close` for the just-closed session

For each ticker:
1. Compute `range = d1.high - d1.low`.
2. **Skip if `range <= 0`** (doji / single-print bar — undefined).
3. Compute `cl = (d1.close - d1.low) / range`.
4. If `cl <= closePct / 100`, add the ticker to a **candidate list** along
   with `d1.low`, `d1.high`, `d1.close`, and the date.

Persist that candidate list (DB row, JSON file, in-memory cache, whatever the
existing scanner uses) so it survives until tomorrow's open.

### Pass B: Just after market open on day N+1 (the "gap up" pass)

Inputs needed per candidate:
- `d2.open` — the official 9:30 ET opening print (or the first 1m bar's
  open, depending on data source)
- `d1.low` and `d1.high` — already saved from Pass A

For each candidate:
1. Compute `gl = (d2.open - d1.low) / (d1.high - d1.low)`.
2. If `gl >= gapPct / 100`, surface the ticker as a triggered signal.

### Timing notes

- **D2 open**: use the *official* opening print (9:30:00 ET). Polygon and most
  vendors expose this as either a daily bar field or the first 1m bar. Don't
  use pre-market quotes — they often don't reflect what actually executed
  at the open.
- **Refresh window**: Pass B can re-run for a few minutes after the open if
  the open print arrives slowly, but once you have it, the value is final.
- **Halts / IPO day / no open print**: skip the candidate; don't substitute
  pre-market quotes.

---

## Reference implementation (JavaScript)

These are the exact functions used in the validated backtester. Translate
them as-is to the scanner's runtime — the math doesn't depend on Node vs
browser vs Python.

```js
// Pass A: scan daily bars for ugly closes.
// Input: closes[] = array of {date, open, high, low, close}, sorted ascending.
// Output: array of candidates (one per ugly-close day).
function findUglyCloseCandidates(bars, closePct) {
  const cp = closePct / 100;
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    const d1 = bars[i];
    const range = d1.high - d1.low;
    if (range <= 0) continue;                      // doji guard
    const cl = (d1.close - d1.low) / range;
    if (cl > cp) continue;
    out.push({
      ticker: d1.ticker,
      d1Date: d1.date,
      d1Low:  d1.low,
      d1High: d1.high,
      d1Close: d1.close,
      cl: +(cl * 100).toFixed(1)                   // store the actual cl% for later analysis
    });
  }
  return out;
}

// Pass B: given yesterday's candidates and today's open prints, return triggers.
function findGapUpTriggers(candidates, openPriceByTicker, gapPct) {
  const gp = gapPct / 100;
  const out = [];
  for (const c of candidates) {
    const d2Open = openPriceByTicker[c.ticker];
    if (d2Open == null) continue;                  // no open print yet / halted
    const range = c.d1High - c.d1Low;
    const gl = (d2Open - c.d1Low) / range;
    if (gl < gp) continue;
    out.push({
      ...c,
      d2Open,
      gl: +(gl * 100).toFixed(1)
    });
  }
  return out;
}
```

---

## Edge cases to handle

| Case | Recommended behavior |
|------|----------------------|
| `d1.high == d1.low` (range = 0) | Skip — `cl` is undefined. Will not pass any threshold. |
| Stock halted at the open on D2 | Skip until first executed print arrives. |
| `d2.open` not yet available (delayed feed) | Re-run Pass B every few seconds until it appears, or skip with a warning. |
| Ticker not in feed today (delisted overnight) | Drop silently from the candidate list. |
| Gap is so strong that `gl > 1.0` | Valid — surface it. These are the strongest signals. Don't cap at 100%. |
| `d2.open < d1.low` (gap down) | `gl` will be negative. Won't pass any non-negative threshold. |

---

## UI / config recommendations

If the scanner has a config panel:

```
Day 1 close ≤ [   25 ] %  of D1 range   (lower = stricter)
Day 2 open  ≥ [   50 ] %  of D1 range   (higher = stricter)
```

Persist both values to whatever store the scanner already uses (localStorage,
DB row, query param). Default to `25` and `50` respectively — those are the
parameters the user has been backtesting against and where they have the most
research.

For each surfaced trigger, display the actual `cl%` and `gl%` values, not
just the boolean pass — knowing a trigger fired with `cl=8%, gl=110%` versus
`cl=24%, gl=51%` materially changes how the user interprets it.

---

## Data fields the scanner already needs (verify before wiring)

For Pass A (per ticker, daily):
- `high`, `low`, `close` for yesterday's session
- `date` (to confirm "yesterday")

For Pass B (per ticker, intraday):
- The 9:30 ET opening print of the current session

If the existing scanner already pulls daily OHLC for its watchlist tickers
(most do), Pass A is a pure CPU pass — no new API calls. Pass B needs one
real-time open quote per candidate, which most scanners already have.

---

## Optional follow-ups (do **not** implement unless asked)

The backtester project includes additional optional filters — SMA-trend
filters on the candidate stock, SPY regime filters, volume thresholds, etc.
These are **out of scope** for this handover. Stick to the two thresholds
above unless the user explicitly asks to port more.

---

## Provenance

These formulas come from the validated `scanDaily()` function in
`ugly_close_gap_up_backtester.html` (the user's existing backtester project).
That code has been run against years of Polygon daily bars, so the math is
not theoretical — it's the same math producing the equity curves the user
has been iterating on.

If anything looks wrong, ground-truth it by reading `scanDaily()` in that
file. The thresholds are stored in `cfg.closePct` and `cfg.gapPct` (both as
integer percents 0–100).
