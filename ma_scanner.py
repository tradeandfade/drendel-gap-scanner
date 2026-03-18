"""Moving Average Crossover Scanner for the Drendel Gap Scanner."""

import logging
from dataclasses import dataclass, asdict
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class MACrossAlert:
    """A moving average crossover alert."""
    symbol: str
    ma_period: int
    ma_type: str  # 'sma' or 'ema'
    ma_value: float
    current_price: float
    direction: str  # 'cross_above' or 'cross_below'
    ma_trend: str  # 'rising', 'declining', 'flat'
    special_badge: str  # 'bullish_bounce', 'bearish_rejection', or ''
    timestamp: str = ""

    def to_dict(self):
        return asdict(self)


def compute_sma(closes: list[float], period: int) -> float | None:
    """Compute SMA from a list of closes (most recent at end)."""
    if len(closes) < period:
        return None
    return sum(closes[-period:]) / period


def compute_ema(closes: list[float], period: int) -> float | None:
    """Compute EMA from a list of closes (most recent at end)."""
    if len(closes) < period:
        return None
    k = 2 / (period + 1)
    ema = sum(closes[:period]) / period
    for c in closes[period:]:
        ema = c * k + ema * (1 - k)
    return ema


def compute_ma(closes: list[float], period: int, ma_type: str) -> float | None:
    """Compute MA based on type."""
    if ma_type == 'ema':
        return compute_ema(closes, period)
    return compute_sma(closes, period)


def get_ma_trend(closes: list[float], period: int, ma_type: str) -> str:
    """
    Determine if the MA itself is rising, declining, or flat.
    Compare today's MA value to yesterday's MA value.
    """
    if len(closes) < period + 1:
        return "flat"

    today_ma = compute_ma(closes, period, ma_type)
    yesterday_ma = compute_ma(closes[:-1], period, ma_type)

    if today_ma is None or yesterday_ma is None:
        return "flat"

    diff_pct = ((today_ma - yesterday_ma) / yesterday_ma) * 100 if yesterday_ma != 0 else 0

    if diff_pct > 0.02:
        return "rising"
    elif diff_pct < -0.02:
        return "declining"
    return "flat"


def check_ma_crossovers(
    symbol: str,
    current_price: float,
    daily_closes: list[float],
    ma_configs: list[dict],
    fired_today: set,
    last_sides: dict = None,
) -> list[MACrossAlert]:
    """
    Check if current price is crossing any configured moving averages.

    Tracks where price was relative to each MA on the PREVIOUS scan.
    If price was above and is now below (or vice versa), that's a crossover.
    
    Args:
        last_sides: dict of {alert_key: 'above'|'below'} from previous scan.
                    Modified in place to track current positions.
    """
    alerts = []

    if len(daily_closes) < 2:
        return alerts

    if last_sides is None:
        last_sides = {}

    for mac in ma_configs:
        period = mac.get("period", 20)
        ma_type = mac.get("type", "sma")

        ma_value = compute_ma(daily_closes, period, ma_type)
        if ma_value is None:
            continue

        side_key = f"{symbol}_ma{period}_{ma_type}"

        # Determine current side
        if current_price > ma_value:
            current_side = "above"
        elif current_price < ma_value:
            current_side = "below"
        else:
            current_side = "at"  # Exactly at the MA

        prev_side = last_sides.get(side_key)

        # Update tracked position
        if current_side != "at":
            last_sides[side_key] = current_side

        # Detect crossover
        direction = None
        if prev_side == "above" and current_side in ("below", "at"):
            direction = "cross_below"
        elif prev_side == "below" and current_side in ("above", "at"):
            direction = "cross_above"

        if direction is None:
            continue

        # Dedup: one alert per MA per ticker per day (any direction)
        alert_key = f"{symbol}_ma{period}_{ma_type}"
        if alert_key in fired_today:
            continue
        fired_today.add(alert_key)

        # Get MA trend
        ma_trend = get_ma_trend(daily_closes, period, ma_type)

        # Special badges
        # Bullish bounce: price crossing DOWN into a RISING MA (pullback to rising support)
        # Bearish rejection: price crossing UP into a DECLINING MA (rally into declining resistance)
        special_badge = ""
        if direction == "cross_below" and ma_trend == "rising":
            special_badge = "bullish_bounce"
        elif direction == "cross_above" and ma_trend == "declining":
            special_badge = "bearish_rejection"

        alerts.append(MACrossAlert(
            symbol=symbol,
            ma_period=period,
            ma_type=ma_type,
            ma_value=round(ma_value, 2),
            current_price=round(current_price, 2),
            direction=direction,
            ma_trend=ma_trend,
            special_badge=special_badge,
        ))

    return alerts
