"""Financial Modeling Prep (FMP) data fetcher for the Drendel Gap Scanner."""

import logging
from datetime import date, datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

import httpx

from models import BarData

logger = logging.getLogger(__name__)
ET = ZoneInfo("America/New_York")

FMP_BASE = "https://financialmodelingprep.com/api/v3"

# FMP timeframe endpoint mapping
TF_ENDPOINTS = {
    "1Min": "historical-chart/1min",
    "5Min": "historical-chart/5min",
    "15Min": "historical-chart/15min",
    "30Min": "historical-chart/30min",
    "1Hour": "historical-chart/1hour",
    "4Hour": "historical-chart/4hour",
    "1Day": "historical-price-full",
    "1Week": "historical-price-full",
}


class FMPFetcher:
    """Fetches market data from Financial Modeling Prep."""

    def __init__(self, api_key: str):
        self.api_key = api_key
        self._client: Optional[httpx.AsyncClient] = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=30.0)
        return self._client

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    async def validate_keys(self) -> tuple[bool, str]:
        """Validate FMP API key."""
        try:
            client = await self._get_client()
            resp = await client.get(
                f"{FMP_BASE}/stock/list",
                params={"apikey": self.api_key},
            )
            if resp.status_code == 200:
                data = resp.json()
                if isinstance(data, list) and len(data) > 0:
                    return True, "FMP key validated."
                elif isinstance(data, dict) and data.get("Error Message"):
                    return False, "Invalid FMP API key."
            return False, f"FMP error: {resp.status_code}"
        except Exception as e:
            return False, f"Connection error: {e}"

    async def fetch_daily_bars(self, symbol: str, lookback_days: int = 252) -> list[BarData]:
        return await self.fetch_bars(symbol, "1Day", lookback_days)

    async def fetch_bars(self, symbol: str, timeframe: str = "1Day", lookback_days: int = 252) -> list[BarData]:
        """Fetch OHLCV bars from FMP."""
        endpoint = TF_ENDPOINTS.get(timeframe)
        if not endpoint:
            logger.error(f"Unsupported FMP timeframe: {timeframe}")
            return []

        end_date = date.today()
        if timeframe in ("1Day", "1Week"):
            start_date = end_date - timedelta(days=int(lookback_days * 1.5))
        else:
            start_date = end_date - timedelta(days=lookback_days)

        bars = []
        try:
            client = await self._get_client()

            if timeframe in ("1Day", "1Week"):
                # Daily/weekly uses historical-price-full
                resp = await client.get(
                    f"{FMP_BASE}/{endpoint}/{symbol}",
                    params={
                        "apikey": self.api_key,
                        "from": start_date.isoformat(),
                        "to": end_date.isoformat(),
                    },
                )
                if resp.status_code != 200:
                    logger.error(f"FMP fetch failed for {symbol}: {resp.status_code}")
                    return []

                data = resp.json()
                historical = data.get("historical", [])

                # FMP returns newest first, reverse for oldest first
                for r in reversed(historical):
                    try:
                        bar_date = date.fromisoformat(r["date"])
                        bars.append(BarData(
                            symbol=symbol,
                            bar_date=bar_date,
                            open=float(r["open"]),
                            high=float(r["high"]),
                            low=float(r["low"]),
                            close=float(r["close"]),
                            volume=int(r.get("volume", 0)),
                        ))
                    except (KeyError, ValueError) as e:
                        continue

                # For weekly, aggregate daily bars into weeks
                if timeframe == "1Week" and bars:
                    bars = _aggregate_weekly(bars)

            else:
                # Intraday endpoints
                resp = await client.get(
                    f"{FMP_BASE}/{endpoint}/{symbol}",
                    params={
                        "apikey": self.api_key,
                        "from": start_date.isoformat(),
                        "to": end_date.isoformat(),
                    },
                )
                if resp.status_code != 200:
                    logger.error(f"FMP intraday fetch failed for {symbol}: {resp.status_code}")
                    return []

                data = resp.json()
                if not isinstance(data, list):
                    logger.error(f"FMP unexpected response for {symbol}")
                    return []

                # FMP returns newest first for intraday too
                for r in reversed(data):
                    try:
                        ts_str = r.get("date", "")
                        ts = datetime.fromisoformat(ts_str).replace(tzinfo=ET)
                        bars.append(BarData(
                            symbol=symbol,
                            bar_date=ts,
                            open=float(r["open"]),
                            high=float(r["high"]),
                            low=float(r["low"]),
                            close=float(r["close"]),
                            volume=int(r.get("volume", 0)),
                        ))
                    except (KeyError, ValueError) as e:
                        continue

        except Exception as e:
            logger.error(f"FMP error fetching {symbol}: {e}")

        logger.info(f"FMP: Fetched {len(bars)} {timeframe} bars for {symbol}")
        return bars

    async def fetch_latest_prices(self, symbols: list[str]) -> dict[str, float]:
        """Fetch latest prices from FMP."""
        prices = {}
        if not symbols:
            return prices

        try:
            client = await self._get_client()

            # FMP batch quote endpoint
            for i in range(0, len(symbols), 50):
                chunk = symbols[i:i + 50]
                symbols_str = ",".join(chunk)

                resp = await client.get(
                    f"{FMP_BASE}/quote/{symbols_str}",
                    params={"apikey": self.api_key},
                )

                if resp.status_code == 200:
                    data = resp.json()
                    if isinstance(data, list):
                        for quote in data:
                            sym = quote.get("symbol", "")
                            price = quote.get("price") or quote.get("previousClose")
                            if sym and price:
                                prices[sym] = float(price)
                else:
                    logger.error(f"FMP quote failed: {resp.status_code}")

        except Exception as e:
            logger.error(f"FMP price fetch error: {e}")

        return prices

    async def fetch_latest_daily_bar(self, symbol: str) -> Optional[BarData]:
        """Fetch most recent daily bar."""
        bars = await self.fetch_bars(symbol, "1Day", 5)
        return bars[-1] if bars else None


def _aggregate_weekly(daily_bars: list[BarData]) -> list[BarData]:
    """Aggregate daily bars into weekly bars."""
    if not daily_bars:
        return []

    weeks = []
    current_week = None
    week_open = week_high = week_low = week_close = 0.0
    week_vol = 0

    for bar in daily_bars:
        bar_date = bar.bar_date if isinstance(bar.bar_date, date) else bar.bar_date.date()
        # ISO week number
        week_num = bar_date.isocalendar()[1]
        week_year = bar_date.isocalendar()[0]
        week_key = (week_year, week_num)

        if current_week != week_key:
            if current_week is not None:
                weeks.append(BarData(
                    symbol=bar.symbol,
                    bar_date=week_start,
                    open=week_open,
                    high=week_high,
                    low=week_low,
                    close=week_close,
                    volume=week_vol,
                ))
            current_week = week_key
            week_start = bar_date
            week_open = bar.open
            week_high = bar.high
            week_low = bar.low
            week_vol = 0

        week_high = max(week_high, bar.high)
        week_low = min(week_low, bar.low)
        week_close = bar.close
        week_vol += bar.volume

    # Last week
    if current_week is not None:
        weeks.append(BarData(
            symbol=daily_bars[-1].symbol,
            bar_date=week_start,
            open=week_open,
            high=week_high,
            low=week_low,
            close=week_close,
            volume=week_vol,
        ))

    return weeks
