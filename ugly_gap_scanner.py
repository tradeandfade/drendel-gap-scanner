"""Ugly Close -> Gap Up scanner for the Drendel Gap Scanner.

Two-pass pattern detector:
  Pass A (after close on D1): mark tickers whose close was in the bottom
    `close_pct` of D1's range.
  Pass B (after open on D2): fire when D2 open is at/above `gap_pct` of
    D1's range.

Both thresholds use D1's high-low range as the denominator. See
SCANNER_HANDOVER.md for the math, edge cases, and reference JS impl.
"""

from dataclasses import dataclass, asdict


@dataclass
class UglyGapCandidate:
    """A D1 ugly-close candidate awaiting D2 open."""
    symbol: str
    d1_date: str
    d1_low: float
    d1_high: float
    d1_close: float
    cl_pct: float  # actual close position 0-100 inside D1 range

    def to_dict(self):
        return asdict(self)


@dataclass
class UglyGapAlert:
    """A triggered ugly-close -> gap-up signal."""
    symbol: str
    d1_date: str
    d1_low: float
    d1_high: float
    d1_close: float
    d2_open: float
    cl_pct: float  # D1 close position inside D1 range
    gl_pct: float  # D2 open position inside D1 range
    timestamp: str = ""

    def to_dict(self):
        return asdict(self)


def run_pass_a(latest_bars_by_symbol: dict, close_pct: float) -> list[UglyGapCandidate]:
    """Pass A: scan latest daily bars for ugly closes.

    Args:
        latest_bars_by_symbol: dict of {symbol: BarData} for the just-closed session.
        close_pct: threshold in percent (0-100). Lower = stricter.

    Returns: list of candidates that pass the threshold.
    """
    cp = close_pct / 100.0
    out = []
    for symbol, bar in latest_bars_by_symbol.items():
        if bar is None:
            continue
        rng = bar.high - bar.low
        if rng <= 0:
            continue  # doji guard — undefined ratio
        cl = (bar.close - bar.low) / rng
        if cl > cp:
            continue
        d1_date = bar.bar_date.isoformat() if hasattr(bar.bar_date, "isoformat") else str(bar.bar_date)
        out.append(UglyGapCandidate(
            symbol=symbol,
            d1_date=d1_date,
            d1_low=float(bar.low),
            d1_high=float(bar.high),
            d1_close=float(bar.close),
            cl_pct=round(cl * 100, 1),
        ))
    return out


def run_pass_b(candidates: list, opens_by_symbol: dict, gap_pct: float) -> list[UglyGapAlert]:
    """Pass B: given D1 candidates and D2 opens, return triggers.

    Args:
        candidates: list of UglyGapCandidate (or dicts with same fields).
        opens_by_symbol: dict of {symbol: float} D2 opening prints.
        gap_pct: threshold in percent (0-200+). Higher = stricter.

    Returns: list of alerts where D2 open >= gap_pct% of D1 range.
    """
    gp = gap_pct / 100.0
    out = []
    for c in candidates:
        if isinstance(c, dict):
            symbol = c["symbol"]
            d1_low = c["d1_low"]
            d1_high = c["d1_high"]
            d1_close = c["d1_close"]
            d1_date = c["d1_date"]
            cl_pct = c["cl_pct"]
        else:
            symbol = c.symbol
            d1_low = c.d1_low
            d1_high = c.d1_high
            d1_close = c.d1_close
            d1_date = c.d1_date
            cl_pct = c.cl_pct

        d2_open = opens_by_symbol.get(symbol)
        if d2_open is None:
            continue
        rng = d1_high - d1_low
        if rng <= 0:
            continue
        gl = (d2_open - d1_low) / rng
        if gl < gp:
            continue
        out.append(UglyGapAlert(
            symbol=symbol,
            d1_date=d1_date,
            d1_low=float(d1_low),
            d1_high=float(d1_high),
            d1_close=float(d1_close),
            d2_open=float(d2_open),
            cl_pct=float(cl_pct),
            gl_pct=round(gl * 100, 1),
        ))
    return out
