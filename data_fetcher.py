"""Alpaca Markets data fetcher for the Drendel Gap Scanner."""

import logging
from datetime import date, datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

import httpx

from models import BarData

logger = logging.getLogger(__name__)

ET = ZoneInfo("America/New_York")

# Alpaca API endpoints
PAPER_BASE = "https://paper-api.alpaca.markets"
LIVE_BASE = "https://api.alpaca.markets"
DATA_BASE = "https://data.alpaca.markets"


class AlpacaFetcher:
    """Fetches market data from Alpaca."""

    def __init__(self, api_key: str, secret_key: str, base_url: str = PAPER_BASE):
        self.api_key = api_key
        self.secret_key = secret_key
        self.base_url = base_url
        self.data_url = DATA_BASE
        self.headers = {
            "APCA-API-KEY-ID": api_key,
            "APCA-API-SECRET-KEY": secret_key,
        }
        self._client: Optional[httpx.AsyncClient] = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                headers=self.headers,
                timeout=30.0,
            )
        return self._client

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    async def validate_keys(self) -> tuple[bool, str]:
        """Test API keys against Alpaca's account endpoint."""
        try:
            client = await self._get_client()
            resp = await client.get(f"{self.base_url}/v2/account")
            if resp.status_code == 200:
                return True, "API keys validated successfully."
            elif resp.status_code == 403:
                return False, "Invalid API keys. Please check your key and secret."
            else:
                return False, f"Unexpected response: {resp.status_code}"
        except Exception as e:
            return False, f"Connection error: {str(e)}"

    async def validate_symbols(self, symbols: list[str]) -> tuple[list[str], list[str]]:
        """Check which symbols are valid tradeable assets on Alpaca."""
        valid = []
        invalid = []
        try:
            client = await self._get_client()
            resp = await client.get(
                f"{self.base_url}/v2/assets",
                params={"status": "active", "asset_class": "us_equity"},
            )
            if resp.status_code == 200:
                assets = {a["symbol"] for a in resp.json()}
                for s in symbols:
                    s_upper = s.upper().strip()
                    if s_upper in assets:
                        valid.append(s_upper)
                    else:
                        invalid.append(s_upper)
            else:
                # If we can't fetch assets, assume all valid
                valid = [s.upper().strip() for s in symbols]
        except Exception as e:
            logger.warning(f"Could not validate symbols: {e}")
            valid = [s.upper().strip() for s in symbols]

        return valid, invalid

    async def fetch_daily_bars(
        self, symbol: str, lookback_days: int = 252
    ) -> list[BarData]:
        """Fetch daily OHLCV bars for a symbol."""
        return await self.fetch_bars(symbol, "1Day", lookback_days)

    async def fetch_bars(
        self, symbol: str, timeframe: str = "1Day", lookback_days: int = 252
    ) -> list[BarData]:
        """Fetch OHLCV bars for any timeframe.
        
        Timeframe options: 1Min, 5Min, 15Min, 30Min, 1Hour, 4Hour, 1Day, 1Week
        """
        end_date = date.today()
        # More history for daily/weekly, less for intraday
        if timeframe in ("1Day", "1Week"):
            start_date = end_date - timedelta(days=int(lookback_days * 1.5))
        elif timeframe == "4Hour":
            start_date = end_date - timedelta(days=90)
        elif timeframe == "1Hour":
            start_date = end_date - timedelta(days=30)
        elif timeframe in ("30Min", "15Min"):
            start_date = end_date - timedelta(days=14)
        elif timeframe in ("5Min", "1Min"):
            start_date = end_date - timedelta(days=5)
        else:
            start_date = end_date - timedelta(days=int(lookback_days * 1.5))

        bars = []
        page_token = None

        try:
            client = await self._get_client()

            while True:
                params = {
                    "start": start_date.isoformat(),
                    "end": end_date.isoformat(),
                    "timeframe": timeframe,
                    "limit": 10000,
                    "adjustment": "split",
                    "feed": "iex",
                    "sort": "asc",
                }
                if page_token:
                    params["page_token"] = page_token

                resp = await client.get(
                    f"{self.data_url}/v2/stocks/{symbol}/bars",
                    params=params,
                )

                if resp.status_code != 200:
                    logger.error(f"Failed to fetch bars for {symbol}: {resp.status_code} {resp.text}")
                    break

                data = resp.json()
                raw_bars = data.get("bars", [])

                if not raw_bars:
                    break

                for b in raw_bars:
                    ts = datetime.fromisoformat(b["t"].replace("Z", "+00:00")).astimezone(ET)
                    bars.append(BarData(
                        symbol=symbol,
                        bar_date=ts.date() if timeframe in ("1Day", "1Week") else ts,
                        open=float(b["o"]),
                        high=float(b["h"]),
                        low=float(b["l"]),
                        close=float(b["c"]),
                        volume=int(b["v"]),
                    ))

                page_token = data.get("next_page_token")
                if not page_token:
                    break

        except Exception as e:
            logger.error(f"Error fetching bars for {symbol}: {e}")

        logger.info(f"Fetched {len(bars)} {timeframe} bars for {symbol}")
        return bars

    async def fetch_latest_prices(self, symbols: list[str]) -> dict[str, float]:
        """Batch fetch latest prices for multiple symbols."""
        prices = {}
        if not symbols:
            return prices

        try:
            client = await self._get_client()

            # Alpaca supports multi-symbol snapshot
            # Process in chunks of 50 to avoid URL length limits
            for i in range(0, len(symbols), 50):
                chunk = symbols[i:i + 50]
                symbols_param = ",".join(chunk)

                resp = await client.get(
                    f"{self.data_url}/v2/stocks/snapshots",
                    params={"symbols": symbols_param, "feed": "iex"},
                )

                if resp.status_code == 200:
                    data = resp.json()
                    for sym, snapshot in data.items():
                        # Use latest trade price, fall back to latest bar close
                        if "latestTrade" in snapshot and snapshot["latestTrade"]:
                            prices[sym] = float(snapshot["latestTrade"]["p"])
                        elif "minuteBar" in snapshot and snapshot["minuteBar"]:
                            prices[sym] = float(snapshot["minuteBar"]["c"])
                        elif "dailyBar" in snapshot and snapshot["dailyBar"]:
                            prices[sym] = float(snapshot["dailyBar"]["c"])
                else:
                    logger.error(f"Failed to fetch snapshots: {resp.status_code}")

        except Exception as e:
            logger.error(f"Error fetching latest prices: {e}")

        return prices

    async def fetch_latest_daily_bar(self, symbol: str) -> Optional[BarData]:
        """Fetch the most recent completed daily bar for a symbol."""
        try:
            client = await self._get_client()
            end_date = date.today()
            start_date = end_date - timedelta(days=5)

            resp = await client.get(
                f"{self.data_url}/v2/stocks/{symbol}/bars",
                params={
                    "start": start_date.isoformat(),
                    "end": end_date.isoformat(),
                    "timeframe": "1Day",
                    "limit": 5,
                    "adjustment": "split",
                    "feed": "iex",
                    "sort": "desc",
                },
            )

            if resp.status_code == 200:
                data = resp.json()
                raw_bars = data.get("bars", [])
                if raw_bars:
                    b = raw_bars[0]
                    bar_date = datetime.fromisoformat(b["t"].replace("Z", "+00:00")).astimezone(ET).date()
                    return BarData(
                        symbol=symbol,
                        bar_date=bar_date,
                        open=float(b["o"]),
                        high=float(b["h"]),
                        low=float(b["l"]),
                        close=float(b["c"]),
                        volume=int(b["v"]),
                    )
        except Exception as e:
            logger.error(f"Error fetching latest bar for {symbol}: {e}")

        return None
