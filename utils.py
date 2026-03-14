"""Utility functions for the Drendel Gap Scanner."""

import logging
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")

MARKET_OPEN = time(9, 30)
MARKET_CLOSE = time(16, 0)


def setup_logging(level=logging.INFO):
    """Configure logging."""
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    # Quiet noisy libraries
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)


def now_et() -> datetime:
    """Get current time in Eastern."""
    return datetime.now(ET)


def is_market_open() -> bool:
    """Check if US stock market is currently open (rough check, ignores holidays)."""
    now = now_et()
    if now.weekday() >= 5:  # Saturday=5, Sunday=6
        return False
    current_time = now.time()
    return MARKET_OPEN <= current_time <= MARKET_CLOSE


def is_after_close_today() -> bool:
    """Check if market has closed for today but it's still the same day."""
    now = now_et()
    if now.weekday() >= 5:
        return False
    return now.time() > MARKET_CLOSE


def next_market_open() -> datetime:
    """Get the next market open time."""
    now = now_et()
    today_open = now.replace(hour=9, minute=30, second=0, microsecond=0)

    if now < today_open and now.weekday() < 5:
        return today_open

    # Move to next weekday
    next_day = now + timedelta(days=1)
    while next_day.weekday() >= 5:
        next_day += timedelta(days=1)

    return next_day.replace(hour=9, minute=30, second=0, microsecond=0)


def format_price(price: float) -> str:
    """Format a price for display."""
    if price >= 1000:
        return f"${price:,.2f}"
    elif price >= 1:
        return f"${price:.2f}"
    else:
        return f"${price:.4f}"
