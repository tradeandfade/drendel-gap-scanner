"""Polygon.io data fetcher for the Drendel Gap Scanner."""

import logging
from datetime import date, datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

import httpx

from models import BarData

logger = logging.getLogger(__name__)
ET = ZoneInfo("America/New_York")

POLYGON_BASE = "https://api.polygon.io"

# Polygon timeframe mapping
TF_MAP = {
    "1Min": ("minute", 1),
    "5Min": ("minute", 5),
    "15Min": ("minute", 15),
    "30Min": ("minute", 30),
    "1Hour": ("hour", 1),
    "4Hour": ("hour", 4),
    "1Day": ("day", 1),
    "1Week": ("week", 1),
}


class PolygonFetcher:
    """Fetches market data from Polygon.io."""

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
        """Validate Polygon API key."""
        try:
            client = await self._get_client()
            resp = await client.get(
                f"{POLYGON_BASE}/v3/reference/tickers",
                params={"apiKey": self.api_key, "limit": 1},
            )
            if resp.status_code == 200:
                return True, "Polygon.io key validated."
            elif resp.status_code == 401 or resp.status_code == 403:
                return False, "Invalid Polygon.io API key."
            else:
                return False, f"Polygon.io error: {resp.status_code}"
        except Exception as e:
            return False, f"Connection error: {e}"

    async def fetch_daily_bars(self, symbol: str, lookback_days: int = 252) -> list[BarData]:
        return await self.fetch_bars(symbol, "1Day", lookback_days)

    async def fetch_bars(self, symbol: str, timeframe: str = "1Day", lookback_days: int = 252) -> list[BarData]:
        """Fetch OHLCV bars from Polygon.io."""
        tf_info = TF_MAP.get(timeframe)
        if not tf_info:
            logger.error(f"Unsupported timeframe: {timeframe}")
            return []

        multiplier_unit, multiplier = tf_info
        end_date = date.today()

        # Calculate start date based on timeframe
        if timeframe in ("1Day", "1Week"):
            start_date = end_date - timedelta(days=int(lookback_days * 1.5))
        else:
            start_date = end_date - timedelta(days=lookback_days)

        bars = []
        try:
            client = await self._get_client()

            # Polygon aggregates endpoint
            url = f"{POLYGON_BASE}/v2/aggs/ticker/{symbol}/range/{multiplier}/{multiplier_unit}/{start_date.isoformat()}/{end_date.isoformat()}"
            resp = await client.get(url, params={
                "apiKey": self.api_key,
                "adjusted": "true",
                "sort": "asc",
                "limit": 50000,
            })

            if resp.status_code != 200:
                logger.error(f"Polygon fetch failed for {symbol}: {resp.status_code} {resp.text[:200]}")
                return []

            data = resp.json()
            results = data.get("results", [])

            for r in results:
                ts = datetime.fromtimestamp(r["t"] / 1000, tz=ET)
                bars.append(BarData(
                    symbol=symbol,
                    bar_date=ts.date() if timeframe in ("1Day", "1Week") else ts,
                    open=float(r["o"]),
                    high=float(r["h"]),
                    low=float(r["l"]),
                    close=float(r["c"]),
                    volume=int(r.get("v", 0)),
                ))

        except Exception as e:
            logger.error(f"Polygon error fetching {symbol}: {e}")

        logger.info(f"Polygon: Fetched {len(bars)} {timeframe} bars for {symbol}")
        return bars

    async def fetch_latest_prices(self, symbols: list[str]) -> dict[str, float]:
        """Fetch latest prices from Polygon snapshots."""
        prices = {}
        if not symbols:
            return prices

        try:
            client = await self._get_client()

            # Polygon supports batch snapshot
            # Process in chunks to respect URL limits
            for i in range(0, len(symbols), 50):
                chunk = symbols[i:i + 50]
                tickers_param = ",".join(chunk)

                resp = await client.get(
                    f"{POLYGON_BASE}/v2/snapshot/locale/us/markets/stocks/tickers",
                    params={"apiKey": self.api_key, "tickers": tickers_param},
                )

                if resp.status_code == 200:
                    data = resp.json()
                    for ticker_data in data.get("tickers", []):
                        sym = ticker_data.get("ticker", "")
                        # Use last trade, fall back to day close
                        if "lastTrade" in ticker_data and ticker_data["lastTrade"]:
                            prices[sym] = float(ticker_data["lastTrade"]["p"])
                        elif "day" in ticker_data and ticker_data["day"]:
                            prices[sym] = float(ticker_data["day"]["c"])
                        elif "prevDay" in ticker_data and ticker_data["prevDay"]:
                            prices[sym] = float(ticker_data["prevDay"]["c"])
                else:
                    logger.error(f"Polygon snapshot failed: {resp.status_code}")

        except Exception as e:
            logger.error(f"Polygon price fetch error: {e}")

        return prices

    async def fetch_latest_daily_bar(self, symbol: str) -> Optional[BarData]:
        """Fetch most recent daily bar."""
        bars = await self.fetch_bars(symbol, "1Day", 5)
        return bars[-1] if bars else None
