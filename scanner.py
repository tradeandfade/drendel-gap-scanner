"""Drendel Gap Scanner - Multi-User Application.

Each user gets their own scanner instance with isolated data.
"""

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

import auth
import config
from data_fetcher import AlpacaFetcher
from polygon_fetcher import PolygonFetcher
from fmp_fetcher import FMPFetcher
from gap_engine import build_gap_zones, check_zone_alerts, update_zones_eod
from models import ScannerStatus
from utils import setup_logging, is_market_open, now_et

setup_logging()
logger = logging.getLogger(__name__)


def _create_fetcher(provider: str, cfg: dict):
    """Create the appropriate fetcher based on provider selection."""
    if provider == "polygon" and cfg.get("polygon_api_key"):
        return PolygonFetcher(cfg["polygon_api_key"])
    elif provider == "fmp" and cfg.get("fmp_api_key"):
        return FMPFetcher(cfg["fmp_api_key"])
    else:
        # Default to Alpaca
        return AlpacaFetcher(
            api_key=cfg.get("alpaca_api_key", ""),
            secret_key=cfg.get("alpaca_secret_key", ""),
            base_url=cfg.get("alpaca_base_url", "https://paper-api.alpaca.markets"),
        )

# ---------------------------------------------------------------------------
# Per-user scanner state: username -> state dict
# ---------------------------------------------------------------------------
user_scanners: dict[str, dict] = {}
user_tasks: dict[str, asyncio.Task] = {}


def get_user_state(username: str) -> dict:
    if username not in user_scanners:
        user_scanners[username] = {
            "fetcher": None,
            "zones": {},
            "alerts": {"support": [], "resistance": [], "untested": []},
            "latest_prices": {},
            "prev_closes": {},
            "status": ScannerStatus(),
            "eod_done_today": False,
            "last_eod_date": None,
        }
    return user_scanners[username]


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------
def get_session_token(request: Request) -> str:
    return request.cookies.get(auth.SESSION_COOKIE, "")


def get_current_user(request: Request) -> str:
    token = get_session_token(request)
    username = auth.verify_session(token)
    if not username:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return username


# ---------------------------------------------------------------------------
# Scanner logic (per-user)
# ---------------------------------------------------------------------------
async def initialize_user_scanner(username: str):
    user_dir = auth.get_user_data_dir(username)
    cfg = config.load_config(user_dir)
    state = get_user_state(username)

    # Check that at least Alpaca keys exist (required as baseline)
    if not cfg.get("alpaca_api_key") or not cfg.get("alpaca_secret_key"):
        state["status"].error = "API keys not configured. Complete setup first."
        state["status"].initialized = False
        return

    # Create scanner fetcher based on provider selection
    scanner_provider = cfg.get("scanner_provider", "alpaca")
    fetcher = _create_fetcher(scanner_provider, cfg)

    valid, msg = await fetcher.validate_keys()
    if not valid:
        # Fall back to Alpaca if selected provider fails
        if scanner_provider != "alpaca":
            logger.warning(f"[{username}] {scanner_provider} validation failed: {msg}. Falling back to Alpaca.")
            fetcher = _create_fetcher("alpaca", cfg)
            valid, msg = await fetcher.validate_keys()
            if not valid:
                state["status"].error = msg
                state["status"].initialized = False
                await fetcher.close()
                return
        else:
            state["status"].error = msg
            state["status"].initialized = False
            await fetcher.close()
            return

    state["fetcher"] = fetcher

    # Create chart fetcher (may be different provider)
    chart_provider = cfg.get("chart_provider", "alpaca")
    if chart_provider != scanner_provider:
        chart_fetcher = _create_fetcher(chart_provider, cfg)
        # Validate chart fetcher silently
        cv, cm = await chart_fetcher.validate_keys()
        if cv:
            state["chart_fetcher"] = chart_fetcher
            logger.info(f"[{username}] Chart provider: {chart_provider}")
        else:
            logger.warning(f"[{username}] Chart provider {chart_provider} failed, using scanner provider")
            state["chart_fetcher"] = fetcher
    else:
        state["chart_fetcher"] = fetcher

    logger.info(f"[{username}] Scanner provider: {scanner_provider}")
    watchlist = cfg.get("watchlist", [])

    if not watchlist:
        state["status"].error = "Watchlist is empty. Add symbols in Settings."
        state["status"].initialized = True
        return

    logger.info(f"[{username}] Initializing scanner with {len(watchlist)} symbols...")
    state["status"].running = True
    state["status"].error = None

    lookback = cfg.get("lookback_days", 252)
    max_gaps = cfg.get("max_gaps_per_symbol", 50)

    # Try loading cached zones first for instant login
    cached_zones = _load_cached_zones(user_dir)
    if cached_zones:
        state["zones"] = cached_zones
        total_zones = sum(len(z) for z in cached_zones.values())
        state["status"].symbol_count = len(watchlist)
        state["status"].zone_count = total_zones
        state["status"].initialized = True
        logger.info(f"[{username}] Loaded {total_zones} cached zones for instant start")

        # Load persisted alerts
        saved_alerts = _load_alerts(user_dir)
        if any(saved_alerts.get(k) for k in ['support', 'resistance', 'untested']):
            state["alerts"] = saved_alerts
            state["status"].alert_count = sum(len(v) for v in saved_alerts.values())

        # Fetch prices
        try:
            prices = await fetcher.fetch_latest_prices(watchlist)
            state["latest_prices"] = prices
        except Exception:
            pass

        # Rebuild zones in background if stale
        asyncio.create_task(_rebuild_zones_background(username, fetcher, watchlist, lookback, max_gaps, user_dir))
        return

    # No cache — build from scratch
    if "daily_closes" not in state:
        state["daily_closes"] = {}
    for symbol in watchlist:
        try:
            bars = await fetcher.fetch_daily_bars(symbol, lookback)
            if len(bars) >= 2:
                zones = build_gap_zones(bars, max_gaps)
                state["zones"][symbol] = zones
                state["prev_closes"][symbol] = bars[-1].close
                state["daily_closes"][symbol] = [b.close for b in bars]
            else:
                state["zones"][symbol] = []
        except Exception as e:
            logger.error(f"[{username}] Error initializing {symbol}: {e}")
            state["zones"][symbol] = []

    total_zones = sum(len(z) for z in state["zones"].values())
    state["status"].symbol_count = len(watchlist)
    state["status"].zone_count = total_zones
    state["status"].initialized = True
    state["status"].error = None
    logger.info(f"[{username}] Scanner initialized: {len(watchlist)} symbols, {total_zones} active zones")

    # Cache zones to disk
    _save_cached_zones(user_dir, state["zones"])

    # Load persisted alerts from disk (survive restarts)
    saved_alerts = _load_alerts(user_dir)
    if any(saved_alerts.get(k) for k in ['support', 'resistance', 'untested']):
        state["alerts"] = saved_alerts
        state["status"].alert_count = sum(len(v) for v in saved_alerts.values())
        logger.info(f"[{username}] Loaded {state['status'].alert_count} persisted alerts from disk")

    try:
        prices = await fetcher.fetch_latest_prices(watchlist)
        state["latest_prices"] = prices
    except Exception as e:
        logger.warning(f"[{username}] Could not fetch initial prices: {e}")

    await run_user_scan_cycle(username)


async def run_user_scan_cycle(username: str):
    state = get_user_state(username)
    user_dir = auth.get_user_data_dir(username)
    cfg = config.load_config(user_dir)
    fetcher = state.get("fetcher")
    if not fetcher or not state["zones"]:
        return

    watchlist = cfg.get("watchlist", [])
    if not watchlist:
        return

    sensitivity = cfg.get("alert_sensitivity", {})
    proximity_pct = sensitivity.get("proximity_pct", 0.0)

    # Custom alert filters
    alert_filters = cfg.get("alert_filters", [])

    # Track which zones already fired today (one alert per zone per day)
    if "fired_today" not in state:
        state["fired_today"] = set()

    try:
        prices = await fetcher.fetch_latest_prices(watchlist)
        state["latest_prices"] = prices
        all_alerts = {"support": [], "resistance": [], "untested": []}
        symbol_side_counts = {}

        for symbol in watchlist:
            price = prices.get(symbol)
            zones = state["zones"].get(symbol, [])
            if price is None or not zones:
                continue

            alerts = check_zone_alerts(zones, price, proximity_pct, proximity_pct, False)

            for alert in alerts:
                base = alert.zone.base_type

                # Apply custom filters
                if alert_filters and not _passes_filters(alert_filters, base, symbol, price, state):
                    continue

                zone_key = f"{alert.symbol}_{alert.zone.id}"
                if zone_key in state["fired_today"]:
                    alert_dict = alert.to_dict()
                    alert_dict["already_fired"] = True
                else:
                    state["fired_today"].add(zone_key)
                    alert_dict = alert.to_dict()
                    alert_dict["already_fired"] = False

                if symbol not in symbol_side_counts:
                    symbol_side_counts[symbol] = {"support": 0, "resistance": 0}
                symbol_side_counts[symbol][base] = symbol_side_counts[symbol].get(base, 0) + 1

                if alert.alert_type == "support_entry":
                    all_alerts["support"].append(alert_dict)
                elif alert.alert_type == "resistance_entry":
                    all_alerts["resistance"].append(alert_dict)
                elif alert.alert_type == "untested_approach":
                    all_alerts["untested"].append(alert_dict)

        for key in all_alerts:
            for a in all_alerts[key]:
                sym = a["symbol"]
                base = a["zone"]["base_type"]
                count = symbol_side_counts.get(sym, {}).get(base, 0)
                a["multi_zone"] = count > 1
                a["same_side_count"] = count
            all_alerts[key].sort(key=lambda a: a["penetration_pct"], reverse=True)

        state["alerts"] = all_alerts
        state["status"].last_scan = now_et().strftime("%Y-%m-%d %H:%M:%S ET")
        state["status"].alert_count = sum(len(v) for v in all_alerts.values())
        state["status"].zone_count = sum(len(z) for z in state["zones"].values())
        _save_alerts(user_dir, all_alerts)

    except Exception as e:
        logger.error(f"[{username}] Scan cycle error: {e}")
        state["status"].error = str(e)


def _compute_sma(closes: list, period: int) -> float | None:
    if len(closes) < period:
        return None
    return sum(closes[-period:]) / period


def _compute_ema(closes: list, period: int) -> float | None:
    if len(closes) < period:
        return None
    k = 2 / (period + 1)
    ema = sum(closes[:period]) / period
    for c in closes[period:]:
        ema = c * k + ema * (1 - k)
    return ema


def _passes_filters(filters: list, base_type: str, symbol: str, price: float, state: dict) -> bool:
    """Check if an alert passes all custom filters."""
    # Get daily closes for this symbol from cached bars
    daily_closes = state.get("daily_closes", {}).get(symbol)
    if not daily_closes:
        return True  # No data to filter on, allow alert

    for f in filters:
        zone_type = f.get("zone_type", "")  # "support" or "resistance"
        if zone_type and zone_type != base_type:
            continue  # This filter doesn't apply to this zone type

        condition = f.get("condition", "")  # "above" or "below"
        ma_period = f.get("ma_period", 200)
        ma_type = f.get("ma_type", "sma")

        if ma_type == "ema":
            ma_val = _compute_ema(daily_closes, ma_period)
        else:
            ma_val = _compute_sma(daily_closes, ma_period)

        if ma_val is None:
            continue  # Not enough data, skip this filter

        if condition == "above" and price <= ma_val:
            return False  # Filter says price must be above MA, but it's not
        if condition == "below" and price >= ma_val:
            return False  # Filter says price must be below MA, but it's not

    return True


def _save_alerts(user_dir: Path, alerts: dict):
    """Save alerts to disk."""
    import json
    path = user_dir / "alerts.json"
    try:
        with open(path, "w") as f:
            json.dump(alerts, f)
    except Exception:
        pass


def _load_alerts(user_dir: Path) -> dict:
    """Load alerts from disk."""
    import json
    path = user_dir / "alerts.json"
    if path.exists():
        try:
            with open(path, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return {"support": [], "resistance": [], "untested": []}


def _save_alert_backup(user_dir: Path, alerts: dict):
    """Save a backup before clearing (for undo)."""
    import json
    path = user_dir / "alerts_backup.json"
    try:
        with open(path, "w") as f:
            json.dump(alerts, f)
    except Exception:
        pass


def _load_alert_backup(user_dir: Path) -> dict | None:
    """Load the backup alerts (for undo)."""
    import json
    path = user_dir / "alerts_backup.json"
    if path.exists():
        try:
            with open(path, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return None


def _save_cached_zones(user_dir: Path, zones_dict: dict):
    """Cache zones to disk for instant login."""
    import json
    path = user_dir / "zones_cache.json"
    try:
        cache = {}
        for symbol, zones in zones_dict.items():
            cache[symbol] = [z.to_dict() for z in zones]
        with open(path, "w") as f:
            json.dump({"zones": cache, "saved_at": now_et().isoformat()}, f)
    except Exception as e:
        logger.warning(f"Could not cache zones: {e}")


def _load_cached_zones(user_dir: Path) -> dict | None:
    """Load cached zones from disk. Returns None if no cache or stale."""
    import json
    from models import GapZone
    path = user_dir / "zones_cache.json"
    if not path.exists():
        return None
    try:
        with open(path, "r") as f:
            data = json.load(f)
        zones_dict = {}
        for symbol, zone_list in data.get("zones", {}).items():
            zones = []
            for zd in zone_list:
                z = GapZone(
                    symbol=zd["symbol"],
                    gap_type=zd["gap_type"],
                    zone_top=zd["zone_top"],
                    zone_bottom=zd["zone_bottom"],
                    original_top=zd["original_top"],
                    original_bottom=zd["original_bottom"],
                    created_date=date.fromisoformat(zd["created_date"]),
                    test_count=zd.get("test_count", 0),
                    reduction_count=zd.get("reduction_count", 0),
                    status=zd.get("status", "active"),
                    id=zd.get("id", ""),
                )
                zones.append(z)
            zones_dict[symbol] = zones
        return zones_dict if zones_dict else None
    except Exception as e:
        logger.warning(f"Could not load zone cache: {e}")
        return None


async def _rebuild_zones_background(username, fetcher, watchlist, lookback, max_gaps, user_dir):
    """Rebuild zones from fresh data in background, then swap in."""
    logger.info(f"[{username}] Background zone rebuild starting...")
    state = get_user_state(username)
    new_zones = {}
    if "daily_closes" not in state:
        state["daily_closes"] = {}
    for symbol in watchlist:
        try:
            bars = await fetcher.fetch_daily_bars(symbol, lookback)
            if len(bars) >= 2:
                new_zones[symbol] = build_gap_zones(bars, max_gaps)
                state["prev_closes"][symbol] = bars[-1].close
                state["daily_closes"][symbol] = [b.close for b in bars]
            else:
                new_zones[symbol] = []
        except Exception as e:
            logger.error(f"[{username}] Background rebuild error for {symbol}: {e}")
            new_zones[symbol] = state["zones"].get(symbol, [])

    state["zones"] = new_zones
    total = sum(len(z) for z in new_zones.values())
    state["status"].zone_count = total
    _save_cached_zones(user_dir, new_zones)
    logger.info(f"[{username}] Background rebuild complete: {total} zones")
    state = get_user_state(username)
    user_dir = auth.get_user_data_dir(username)
    cfg = config.load_config(user_dir)
    fetcher = state.get("fetcher")
    if not fetcher:
        return

    watchlist = cfg.get("watchlist", [])
    max_gaps = cfg.get("max_gaps_per_symbol", 50)
    logger.info(f"[{username}] Running end-of-day zone rebuild...")

    for symbol in watchlist:
        try:
            bar = await fetcher.fetch_latest_daily_bar(symbol)
            if bar:
                prev_close = state["prev_closes"].get(symbol)
                zones = state["zones"].get(symbol, [])
                zones = update_zones_eod(zones, bar, prev_close, max_gaps)
                state["zones"][symbol] = zones
                state["prev_closes"][symbol] = bar.close
        except Exception as e:
            logger.error(f"[{username}] EOD update error for {symbol}: {e}")

    state["status"].zone_count = sum(len(z) for z in state["zones"].values())
    state["status"].last_eod_update = now_et().strftime("%Y-%m-%d %H:%M:%S ET")
    _save_cached_zones(user_dir, state["zones"])
    logger.info(f"[{username}] EOD update complete. {state['status'].zone_count} active zones.")


async def user_scan_loop(username: str):
    state = get_user_state(username)
    while not state["status"].initialized:
        await asyncio.sleep(2)

    logger.info(f"[{username}] Scan loop started.")
    last_reset_date = None

    while True:
        user_dir = auth.get_user_data_dir(username)
        cfg = config.load_config(user_dir)
        interval = cfg.get("scan_interval_seconds", 300)

        et_now = now_et()
        today = et_now.date()

        # Daily reset: clear alerts before market open (9:30 AM ET)
        if last_reset_date != today and et_now.hour < 10 and et_now.weekday() < 5:
            _save_alert_backup(user_dir, state["alerts"])
            state["alerts"] = {"support": [], "resistance": [], "untested": []}
            state["status"].alert_count = 0
            state["fired_today"] = set()  # Reset dedup tracking
            _save_alerts(user_dir, state["alerts"])
            last_reset_date = today
            logger.info(f"[{username}] Daily reset: alerts cleared for new trading day.")

        if state["fetcher"] and state["zones"]:
            await run_user_scan_cycle(username)

        et_now = now_et()
        today = et_now.date()
        if (
            not state["eod_done_today"]
            and state["last_eod_date"] != today
            and et_now.hour >= 16
            and et_now.weekday() < 5
            and state["fetcher"]
        ):
            await run_user_eod_update(username)
            state["eod_done_today"] = True
            state["last_eod_date"] = today

        if is_market_open():
            state["eod_done_today"] = False

        await asyncio.sleep(interval)


async def reinitialize_user(username: str):
    # Cancel existing task
    if username in user_tasks:
        user_tasks[username].cancel()
        try:
            await user_tasks[username]
        except asyncio.CancelledError:
            pass

    state = get_user_state(username)
    if state.get("fetcher"):
        await state["fetcher"].close()

    user_scanners[username] = {
        "fetcher": None,
        "zones": {},
        "alerts": {"support": [], "resistance": [], "untested": []},
        "latest_prices": {},
        "prev_closes": {},
        "status": ScannerStatus(),
        "eod_done_today": False,
        "last_eod_date": None,
    }

    await initialize_user_scanner(username)
    user_tasks[username] = asyncio.create_task(user_scan_loop(username))


async def start_user_scanner(username: str):
    """Start a scanner for a user if not already running."""
    if username in user_tasks and not user_tasks[username].done():
        return  # Already running
    await initialize_user_scanner(username)
    user_tasks[username] = asyncio.create_task(user_scan_loop(username))


# ---------------------------------------------------------------------------
# FastAPI App
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    data_dir_env = os.environ.get("DATA_DIR", "")
    logger.info(f"Drendel Gap Scanner started. DATA_DIR={data_dir_env or '(not set)'}")
    
    if data_dir_env:
        # Wait for the volume to actually mount.
        # Railway mounts volumes asynchronously — the directory exists as an empty
        # folder before the mount is ready. We detect the mount by looking for a
        # marker file we write on first successful access, or by checking if our
        # users.json already exists from a previous deploy.
        data_path = Path(data_dir_env)
        marker = data_path / ".volume_mounted"
        auth_path = data_path / "users.json"
        
        logger.info(f"Waiting for volume mount at {data_path}...")
        
        mounted = False
        for i in range(60):  # Wait up to 60 seconds
            # Check if volume is mounted by looking for our marker or any user data
            if marker.exists() or auth_path.exists():
                mounted = True
                logger.info(f"Volume detected after {i}s (marker={marker.exists()}, auth={auth_path.exists()})")
                break
            
            # Also try writing the marker — if the volume is mounted, this succeeds
            # and persists. If not mounted yet, it writes to the empty overlay dir
            # which will be replaced when the mount happens.
            try:
                # Check if directory is a mount point (has different device than parent)
                import os as _os
                dir_stat = _os.stat(str(data_path))
                parent_stat = _os.stat(str(data_path.parent))
                if dir_stat.st_dev != parent_stat.st_dev:
                    # Different device = volume is mounted
                    mounted = True
                    logger.info(f"Volume mount detected via device check after {i}s")
                    # Write marker for faster detection next time
                    try:
                        marker.touch()
                    except Exception:
                        pass
                    break
            except Exception:
                pass
            
            if i % 5 == 0 and i > 0:
                logger.info(f"Still waiting for volume mount... ({i}s)")
            
            await asyncio.sleep(1)
        
        if not mounted:
            # Last resort: try writing marker anyway and hope for the best
            try:
                data_path.mkdir(parents=True, exist_ok=True)
                marker.touch()
                logger.warning(f"Volume mount not confirmed after 60s, but directory is writable. Proceeding.")
            except Exception as e:
                logger.error(f"Volume mount failed: {e}. Data may not persist!")
        
        # Re-read the data dir now that volume should be mounted
        # Clear the cache so it re-resolves
        auth._cached_data_dir = None
        resolved = auth._data_dir()
        
        final_auth = auth._auth_path()
        logger.info(f"Final auth path: {final_auth}, exists: {final_auth.exists()}")
    
    yield
    # Cleanup all user scanners
    for username, task in user_tasks.items():
        task.cancel()
    for username, state in user_scanners.items():
        if state.get("fetcher"):
            await state["fetcher"].close()


app = FastAPI(title="Drendel Gap Scanner", lifespan=lifespan)

_this_dir = Path(__file__).resolve().parent
static_dir = _this_dir / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")
else:
    fallback = Path.cwd() / "static"
    if fallback.exists():
        static_dir = fallback
        app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


from starlette.middleware.base import BaseHTTPMiddleware

class CacheControlMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path.startswith("/static/"):
            # Short cache for static files — browser will revalidate often
            response.headers["Cache-Control"] = "public, max-age=60"
        elif path.startswith("/api/") or path == "/" or path == "/login":
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
        return response

app.add_middleware(CacheControlMiddleware)


def _no_cache(resp):
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return resp


# ---------------------------------------------------------------------------
# Public Routes
# ---------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    token = get_session_token(request)
    username = auth.verify_session(token)

    if not username:
        return _no_cache(FileResponse(str(static_dir / "login.html")))

    # Start scanner in background — DON'T await, let page load immediately
    asyncio.create_task(start_user_scanner(username))
    return _no_cache(FileResponse(str(static_dir / "index.html")))


@app.get("/login", response_class=HTMLResponse)
async def login_page():
    return _no_cache(FileResponse(str(static_dir / "login.html")))


# ---------------------------------------------------------------------------
# Auth Routes
# ---------------------------------------------------------------------------
@app.get("/api/auth/status")
async def auth_status(request: Request):
    token = get_session_token(request)
    username = auth.verify_session(token)
    return JSONResponse({
        "registered": True,  # Multi-user: registration is always available
        "authenticated": username is not None,
        "username": username,
    })


@app.post("/api/auth/register")
async def do_register(request: Request):
    body = await request.json()
    username = body.get("username", "").strip()
    password = body.get("password", "").strip()

    ok, msg = auth.register(username, password)
    if not ok:
        return JSONResponse({"ok": False, "message": msg}, status_code=400)

    ok, token = auth.verify_login(username, password)
    resp = JSONResponse({"ok": True, "message": "Account created! Redirecting..."})
    resp.set_cookie(auth.SESSION_COOKIE, token, max_age=auth.SESSION_MAX_AGE, httponly=True, samesite="lax")
    return resp


@app.post("/api/auth/login")
async def do_login(request: Request):
    body = await request.json()
    username = body.get("username", "").strip()
    password = body.get("password", "").strip()

    ok, token_or_error = auth.verify_login(username, password)
    if not ok:
        return JSONResponse({"ok": False, "message": token_or_error}, status_code=401)

    resp = JSONResponse({"ok": True, "message": "Logged in."})
    resp.set_cookie(auth.SESSION_COOKIE, token_or_error, max_age=auth.SESSION_MAX_AGE, httponly=True, samesite="lax")
    return resp


@app.post("/api/auth/logout")
async def do_logout(request: Request):
    token = get_session_token(request)
    auth.logout(token)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.SESSION_COOKIE)
    return resp


# ---------------------------------------------------------------------------
# Protected API Routes
# ---------------------------------------------------------------------------
@app.get("/api/alerts")
async def get_alerts(request: Request):
    username = get_current_user(request)
    state = get_user_state(username)
    return JSONResponse(state["alerts"])


@app.post("/api/alerts/clear")
async def clear_alerts(request: Request):
    username = get_current_user(request)
    user_dir = auth.get_user_data_dir(username)
    state = get_user_state(username)
    # Save backup before clearing
    _save_alert_backup(user_dir, state["alerts"])
    state["alerts"] = {"support": [], "resistance": [], "untested": []}
    state["status"].alert_count = 0
    _save_alerts(user_dir, state["alerts"])
    return JSONResponse({"ok": True, "message": "Alerts cleared.", "can_undo": True})


@app.post("/api/alerts/restore")
async def restore_alerts(request: Request):
    username = get_current_user(request)
    user_dir = auth.get_user_data_dir(username)
    state = get_user_state(username)
    backup = _load_alert_backup(user_dir)
    if backup:
        state["alerts"] = backup
        state["status"].alert_count = sum(len(v) for v in backup.values())
        _save_alerts(user_dir, backup)
        return JSONResponse({"ok": True, "message": "Alerts restored."})
    return JSONResponse({"ok": False, "message": "No backup available."}, status_code=404)


@app.get("/api/zones")
async def get_zones(request: Request):
    username = get_current_user(request)
    state = get_user_state(username)
    all_zones = []
    prices = state.get("latest_prices", {})
    for symbol, zones in state["zones"].items():
        price = prices.get(symbol)
        for z in zones:
            zd = z.to_dict()
            if price:
                zd["current_price"] = round(price, 2)
                if z.base_type == "support":
                    zd["distance_pct"] = round((price - z.zone_top) / price * 100, 2) if price > 0 else 0
                else:
                    zd["distance_pct"] = round((z.zone_bottom - price) / price * 100, 2) if price > 0 else 0
            all_zones.append(zd)
    return JSONResponse(all_zones)


@app.get("/api/status")
async def get_status(request: Request):
    username = get_current_user(request)
    state = get_user_state(username)
    return JSONResponse(state["status"].to_dict())


@app.get("/api/settings")
async def get_settings(request: Request):
    username = get_current_user(request)
    user_dir = auth.get_user_data_dir(username)
    cfg = config.load_config(user_dir)
    safe = cfg.copy()
    if safe.get("alpaca_api_key"):
        key = safe["alpaca_api_key"]
        safe["alpaca_api_key_display"] = key[:4] + "****" + key[-4:] if len(key) > 8 else "****"
    if safe.get("alpaca_secret_key"):
        safe["alpaca_secret_key_display"] = "****hidden****"
    if safe.get("polygon_api_key"):
        key = safe["polygon_api_key"]
        safe["polygon_api_key_display"] = key[:4] + "****" + key[-4:] if len(key) > 8 else "****"
    if safe.get("fmp_api_key"):
        key = safe["fmp_api_key"]
        safe["fmp_api_key_display"] = key[:4] + "****" + key[-4:] if len(key) > 8 else "****"
    safe.pop("alpaca_api_key", None)
    safe.pop("alpaca_secret_key", None)
    safe.pop("polygon_api_key", None)
    safe.pop("fmp_api_key", None)
    return JSONResponse(safe)


@app.post("/api/settings")
async def update_settings(request: Request):
    username = get_current_user(request)
    user_dir = auth.get_user_data_dir(username)
    body = await request.json()
    config.update_config(user_dir, body)
    return JSONResponse({"ok": True, "message": "Settings saved."})


@app.get("/api/watchlist")
async def get_watchlist(request: Request):
    username = get_current_user(request)
    user_dir = auth.get_user_data_dir(username)
    cfg = config.load_config(user_dir)
    return JSONResponse({"watchlist": cfg.get("watchlist", [])})


@app.post("/api/watchlist")
async def update_watchlist(request: Request):
    username = get_current_user(request)
    user_dir = auth.get_user_data_dir(username)
    body = await request.json()
    symbols = body.get("watchlist", [])
    cleaned = [s.upper().strip() for s in symbols if s.strip()]
    cleaned = list(dict.fromkeys(cleaned))
    config.update_config(user_dir, {"watchlist": cleaned})
    await reinitialize_user(username)
    state = get_user_state(username)
    total_zones = sum(len(z) for z in state["zones"].values())
    return JSONResponse({
        "ok": True, "watchlist": cleaned,
        "symbol_count": len(cleaned), "zone_count": total_zones,
        "message": f"Watchlist saved. {len(cleaned)} symbols loaded, {total_zones} gap zones found.",
    })


@app.post("/api/setup")
async def setup_keys(request: Request):
    username = get_current_user(request)
    user_dir = auth.get_user_data_dir(username)
    body = await request.json()
    api_key = body.get("alpaca_api_key", "").strip()
    secret_key = body.get("alpaca_secret_key", "").strip()
    base_url = body.get("alpaca_base_url", "https://paper-api.alpaca.markets").strip()

    if not api_key or not secret_key:
        return JSONResponse({"ok": False, "message": "Both API key and secret are required."}, status_code=400)

    fetcher = AlpacaFetcher(api_key, secret_key, base_url)
    valid, msg = await fetcher.validate_keys()
    await fetcher.close()
    if not valid:
        return JSONResponse({"ok": False, "message": msg}, status_code=400)

    config.update_config(user_dir, {"alpaca_api_key": api_key, "alpaca_secret_key": secret_key, "alpaca_base_url": base_url})
    await reinitialize_user(username)
    return JSONResponse({"ok": True, "message": "API keys validated and saved!"})


@app.post("/api/reinitialize")
async def trigger_reinitialize(request: Request):
    username = get_current_user(request)
    await reinitialize_user(username)
    return JSONResponse({"ok": True, "message": "Scanner reinitialized."})


@app.get("/api/chart/{symbol}")
async def get_chart_data(symbol: str, request: Request):
    """Return bars and gap zones for charting."""
    username = get_current_user(request)
    state = get_user_state(username)
    user_dir = auth.get_user_data_dir(username)
    cfg = config.load_config(user_dir)
    # Use chart_fetcher if available (may be a different provider than scanner)
    chart_fetcher = state.get("chart_fetcher") or state.get("fetcher")

    symbol = symbol.upper()
    tf = request.query_params.get("tf", "1Day")
    valid_tfs = {"1Min", "5Min", "15Min", "30Min", "1Hour", "4Hour", "1Day", "1Week"}
    if tf not in valid_tfs:
        tf = "1Day"

    if not chart_fetcher:
        raise HTTPException(status_code=400, detail="Scanner not initialized")

    # Fetch bars — extra history so MAs have data from the start
    lookback_map = {"1Week": 2500, "1Day": 1500, "4Hour": 365, "1Hour": 120, "30Min": 60, "15Min": 30, "5Min": 14, "1Min": 7}
    lookback = lookback_map.get(tf, 1500)

    bars = await chart_fetcher.fetch_bars(symbol, tf, lookback)

    if tf in ("1Day", "1Week"):
        bar_data = [{"date": b.bar_date.isoformat(), "open": b.open, "high": b.high, "low": b.low, "close": b.close, "vol": b.volume} for b in bars]
    else:
        bar_data = [{"date": int(b.bar_date.timestamp()), "open": b.open, "high": b.high, "low": b.low, "close": b.close, "vol": b.volume} for b in bars]

    zones = state["zones"].get(symbol, [])
    zone_data = [z.to_dict() for z in zones]

    return JSONResponse({"bars": bar_data, "zones": zone_data, "timeframe": tf})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("scanner:app", host="0.0.0.0", port=port, reload=False)
