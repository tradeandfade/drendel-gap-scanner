"""Core gap zone engine for the Drendel Gap Scanner.

Translates the TradingView Pine Script gap logic into Python.
Handles gap creation, testing, reduction, and fill.
"""

import logging
from datetime import date
from typing import Optional

from models import BarData, GapZone, Alert

logger = logging.getLogger(__name__)


def build_gap_zones(daily_bars: list[BarData], max_gaps: int = 50) -> list[GapZone]:
    """
    Process historical daily bars to build all currently active gap zones.

    Iterates through bars chronologically:
    1. For each day, check if a new gap formed (vs previous day).
    2. Then check if any existing zones were tested/reduced/filled.

    Args:
        daily_bars: List of BarData sorted oldest-first.
        max_gaps: Maximum number of gap zones to track per symbol.

    Returns:
        List of currently active GapZone objects.
    """
    if len(daily_bars) < 2:
        return []

    zones: list[GapZone] = []
    symbol = daily_bars[0].symbol

    for i in range(1, len(daily_bars)):
        prev_bar = daily_bars[i - 1]
        curr_bar = daily_bars[i]

        # --- Step 1: Check for new gaps ---
        new_zone = _detect_gap(symbol, prev_bar, curr_bar)
        if new_zone:
            zones.append(new_zone)
            # Enforce max gaps limit
            if len(zones) > max_gaps:
                zones = zones[-max_gaps:]

        # --- Step 2: Update existing zones with today's price action ---
        zones = _update_zones_with_bar(zones, curr_bar)

    logger.info(f"{symbol}: Built {len(zones)} active gap zones from {len(daily_bars)} bars")
    return zones


def _detect_gap(symbol: str, prev_bar: BarData, curr_bar: BarData) -> Optional[GapZone]:
    """
    Detect if a gap formed between two consecutive daily bars.

    Gap Up (potential support):
        - curr open > prev close
        - curr low > prev close (gap not filled intraday)
        - Zone: prev_close to curr_low

    Gap Down (potential resistance):
        - curr open < prev close
        - curr high < prev close (gap not filled intraday)
        - Zone: curr_high to prev_close
    """
    prev_close = prev_bar.close

    # Gap Up -> potential support
    if curr_bar.open > prev_close and curr_bar.low > prev_close:
        zone_bottom = prev_close
        zone_top = curr_bar.low
        if zone_top > zone_bottom:  # Ensure valid zone
            return GapZone(
                symbol=symbol,
                gap_type="untested_support",
                zone_top=zone_top,
                zone_bottom=zone_bottom,
                original_top=zone_top,
                original_bottom=zone_bottom,
                created_date=curr_bar.bar_date,
            )

    # Gap Down -> potential resistance
    if curr_bar.open < prev_close and curr_bar.high < prev_close:
        zone_bottom = curr_bar.high
        zone_top = prev_close
        if zone_top > zone_bottom:  # Ensure valid zone
            return GapZone(
                symbol=symbol,
                gap_type="untested_resistance",
                zone_top=zone_top,
                zone_bottom=zone_bottom,
                original_top=zone_top,
                original_bottom=zone_bottom,
                created_date=curr_bar.bar_date,
            )

    return None


def _update_zones_with_bar(zones: list[GapZone], bar: BarData) -> list[GapZone]:
    """
    Update all zones based on a daily bar's price action.

    For support gaps:
        - Price enters zone (low <= zone_top):
            - Close > zone_top: gap holds, mark tested
            - Close within zone: reduce zone_top to close
            - Close < zone_bottom: gap filled, remove

    For resistance gaps:
        - Price enters zone (high >= zone_bottom):
            - Close < zone_bottom: gap holds, mark tested
            - Close within zone: raise zone_bottom to close
            - Close > zone_top: gap filled, remove
    """
    updated = []

    for zone in zones:
        if zone.status == "filled":
            continue

        base_type = zone.base_type  # 'support' or 'resistance'

        if base_type == "support":
            zone = _update_support_zone(zone, bar)
        elif base_type == "resistance":
            zone = _update_resistance_zone(zone, bar)

        if zone.status != "filled":
            updated.append(zone)

    return updated


def _update_support_zone(zone: GapZone, bar: BarData) -> GapZone:
    """
    Update a support gap zone with a bar's price action.

    Support zone: price pulling back into a gap-up area.
    Zone is below current price. Price enters from above.
    """
    # Did price enter the zone? (low touched or went below zone_top)
    if bar.low <= zone.zone_top:
        # Price entered the zone
        if bar.close < zone.zone_bottom:
            # Close below zone bottom = gap filled
            zone.status = "filled"
            logger.debug(f"{zone.symbol}: Support gap filled (close {bar.close} < bottom {zone.zone_bottom})")
        elif bar.close <= zone.zone_top:
            # Close within zone = reduce
            zone.zone_top = bar.close
            zone.reduction_count += 1
            zone.test_count += 1
            zone.status = "reduced"
            # Mark as tested (no longer untested)
            if zone.gap_type.startswith("untested_"):
                zone.gap_type = "support"
            logger.debug(f"{zone.symbol}: Support gap reduced to top={zone.zone_top}")
            # Check if reduction made zone invalid
            if zone.zone_top <= zone.zone_bottom:
                zone.status = "filled"
        else:
            # Close above zone top = gap holds
            zone.test_count += 1
            if zone.gap_type.startswith("untested_"):
                zone.gap_type = "support"
            logger.debug(f"{zone.symbol}: Support gap tested and held")

    return zone


def _update_resistance_zone(zone: GapZone, bar: BarData) -> GapZone:
    """
    Update a resistance gap zone with a bar's price action.

    Resistance zone: price pushing up into a gap-down area.
    Zone is above current price. Price enters from below.
    """
    # Did price enter the zone? (high reached or went above zone_bottom)
    if bar.high >= zone.zone_bottom:
        # Price entered the zone
        if bar.close > zone.zone_top:
            # Close above zone top = gap filled
            zone.status = "filled"
            logger.debug(f"{zone.symbol}: Resistance gap filled (close {bar.close} > top {zone.zone_top})")
        elif bar.close >= zone.zone_bottom:
            # Close within zone = reduce (raise bottom)
            zone.zone_bottom = bar.close
            zone.reduction_count += 1
            zone.test_count += 1
            zone.status = "reduced"
            if zone.gap_type.startswith("untested_"):
                zone.gap_type = "resistance"
            logger.debug(f"{zone.symbol}: Resistance gap reduced to bottom={zone.zone_bottom}")
            # Check if reduction made zone invalid
            if zone.zone_bottom >= zone.zone_top:
                zone.status = "filled"
        else:
            # Close below zone bottom = gap holds
            zone.test_count += 1
            if zone.gap_type.startswith("untested_"):
                zone.gap_type = "resistance"
            logger.debug(f"{zone.symbol}: Resistance gap tested and held")

    return zone


def check_zone_alerts(
    zones: list[GapZone],
    current_price: float,
    support_proximity_pct: float = 0.0,
    resistance_proximity_pct: float = 0.0,
    alert_first_test_only: bool = False,
) -> list[Alert]:
    """
    Check if current price is entering or near any gap zones.

    Args:
        zones: Active gap zones for a symbol.
        current_price: Latest price.
        support_proximity_pct: Alert when within this % of support zone.
        resistance_proximity_pct: Alert when within this % of resistance zone.
        alert_first_test_only: Only alert on first test of a zone.

    Returns:
        List of Alert objects for triggered zones.
    """
    alerts = []

    for zone in zones:
        if zone.status == "filled":
            continue

        if alert_first_test_only and zone.test_count > 0 and not zone.is_untested:
            continue

        alert = _check_single_zone(
            zone, current_price, support_proximity_pct, resistance_proximity_pct
        )
        if alert:
            alerts.append(alert)

    return alerts


def _check_single_zone(
    zone: GapZone,
    price: float,
    support_prox: float,
    resistance_prox: float,
) -> Optional[Alert]:
    """Check if price triggers an alert for a single zone."""

    base_type = zone.base_type
    is_untested = zone.is_untested

    if base_type == "support":
        proximity_threshold = support_prox
        # Support zone is below price. Price approaches from above.
        # Price is IN the zone if: zone_bottom <= price <= zone_top
        if zone.zone_bottom <= price <= zone.zone_top:
            # Inside the zone
            penetration = (zone.zone_top - price) / zone.zone_size * 100 if zone.zone_size > 0 else 100
            alert_type = "untested_approach" if is_untested else "support_entry"
            return Alert(
                symbol=zone.symbol,
                alert_type=alert_type,
                current_price=price,
                zone=zone,
                penetration_pct=penetration,
                distance_pct=0.0,
                is_first_test=(zone.test_count == 0),
            )
        elif price > zone.zone_top and proximity_threshold > 0:
            # Above the zone - check proximity
            distance = (price - zone.zone_top) / price * 100
            if distance <= proximity_threshold:
                alert_type = "untested_approach" if is_untested else "support_entry"
                return Alert(
                    symbol=zone.symbol,
                    alert_type=alert_type,
                    current_price=price,
                    zone=zone,
                    penetration_pct=0.0,
                    distance_pct=round(distance, 2),
                    is_first_test=(zone.test_count == 0),
                )

    elif base_type == "resistance":
        proximity_threshold = resistance_prox
        # Resistance zone is above price. Price approaches from below.
        # Price is IN the zone if: zone_bottom <= price <= zone_top
        if zone.zone_bottom <= price <= zone.zone_top:
            # Inside the zone
            penetration = (price - zone.zone_bottom) / zone.zone_size * 100 if zone.zone_size > 0 else 100
            alert_type = "untested_approach" if is_untested else "resistance_entry"
            return Alert(
                symbol=zone.symbol,
                alert_type=alert_type,
                current_price=price,
                zone=zone,
                penetration_pct=penetration,
                distance_pct=0.0,
                is_first_test=(zone.test_count == 0),
            )
        elif price < zone.zone_bottom and proximity_threshold > 0:
            # Below the zone - check proximity
            distance = (zone.zone_bottom - price) / price * 100
            if distance <= proximity_threshold:
                alert_type = "untested_approach" if is_untested else "resistance_entry"
                return Alert(
                    symbol=zone.symbol,
                    alert_type=alert_type,
                    current_price=price,
                    zone=zone,
                    penetration_pct=0.0,
                    distance_pct=round(distance, 2),
                    is_first_test=(zone.test_count == 0),
                )

    return None


def update_zones_eod(
    zones: list[GapZone],
    today_bar: BarData,
    prev_close: Optional[float] = None,
    max_gaps: int = 50,
) -> list[GapZone]:
    """
    End-of-day zone update. Called after market close.

    1. Check if today created a new gap (needs prev_close).
    2. Update all existing zones with today's completed bar.

    Args:
        zones: Current active zones for the symbol.
        today_bar: Today's completed daily bar.
        prev_close: Previous day's close (for new gap detection).
        max_gaps: Max zones to keep.

    Returns:
        Updated zone list.
    """
    symbol = today_bar.symbol

    # Update existing zones
    zones = _update_zones_with_bar(zones, today_bar)

    # Check for new gap if we have previous close
    if prev_close is not None:
        prev_bar = BarData(
            symbol=symbol,
            bar_date=today_bar.bar_date,  # date doesn't matter for detection
            open=prev_close,
            high=prev_close,
            low=prev_close,
            close=prev_close,
        )
        new_zone = _detect_gap(symbol, prev_bar, today_bar)
        if new_zone:
            zones.append(new_zone)
            logger.info(f"{symbol}: New {new_zone.gap_type} gap created on {today_bar.bar_date}")

    # Enforce limit
    if len(zones) > max_gaps:
        zones = zones[-max_gaps:]

    return zones
