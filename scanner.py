"""Drendel Gap Scanner - Multi-User Application.

Each user gets their own scanner instance with isolated data.
"""

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

import auth
import config
from data_fetcher import AlpacaFetcher
from gap_engine import build_gap_zones, check_zone_alerts, update_zones_eod
from models import ScannerStatus
from utils import setup_logging, is_market_open, now_et

setup_logging()
logger = logging.getLogger(__name__)

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

    if not cfg.get("alpaca_api_key") or not cfg.get("alpaca_secret_key"):
        state["status"].error = "API keys not configured. Complete setup first."
        state["status"].initialized = False
        return

    fetcher = AlpacaFetcher(
        api_key=cfg["alpaca_api_key"],
        secret_key=cfg["alpaca_secret_key"],
        base_url=cfg.get("alpaca_base_url", "https://paper-api.alpaca.markets"),
    )

    valid, msg = await fetcher.validate_keys()
    if not valid:
        state["status"].error = msg
        state["status"].initialized = False
        await fetcher.close()
        return

    state["fetcher"] = fetcher
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

    for symbol in watchlist:
        try:
            bars = await fetcher.fetch_daily_bars(symbol, lookback)
            if len(bars) >= 2:
                zones = build_gap_zones(bars, max_gaps)
                state["zones"][symbol] = zones
                state["prev_closes"][symbol] = bars[-1].close
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
    support_prox = sensitivity.get("support_proximity_pct", 0.0)
    resistance_prox = sensitivity.get("resistance_proximity_pct", 0.0)
    first_test_only = sensitivity.get("alert_on_first_test_only", False)

    try:
        prices = await fetcher.fetch_latest_prices(watchlist)
        state["latest_prices"] = prices
        all_alerts = {"support": [], "resistance": [], "untested": []}

        for symbol in watchlist:
            price = prices.get(symbol)
            zones = state["zones"].get(symbol, [])
            if price is None or not zones:
                continue
            alerts = check_zone_alerts(zones, price, support_prox, resistance_prox, first_test_only)
            for alert in alerts:
                if alert.alert_type == "support_entry":
                    all_alerts["support"].append(alert.to_dict())
                elif alert.alert_type == "resistance_entry":
                    all_alerts["resistance"].append(alert.to_dict())
                elif alert.alert_type == "untested_approach":
                    all_alerts["untested"].append(alert.to_dict())

        for key in all_alerts:
            all_alerts[key].sort(key=lambda a: a["penetration_pct"], reverse=True)

        state["alerts"] = all_alerts
        state["status"].last_scan = now_et().strftime("%Y-%m-%d %H:%M:%S ET")
        state["status"].alert_count = sum(len(v) for v in all_alerts.values())
        state["status"].zone_count = sum(len(z) for z in state["zones"].values())
    except Exception as e:
        logger.error(f"[{username}] Scan cycle error: {e}")
        state["status"].error = str(e)


async def run_user_eod_update(username: str):
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
            state["alerts"] = {"support": [], "resistance": [], "untested": []}
            state["status"].alert_count = 0
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
    data_dir = os.environ.get("DATA_DIR", "(not set, using current dir)")
    logger.info(f"Drendel Gap Scanner started. DATA_DIR={data_dir}")
    logger.info(f"Auth file path: {auth._auth_path()}")
    logger.info(f"Auth file exists: {auth._auth_path().exists()}")
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

    # Start scanner if not running
    await start_user_scanner(username)
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
    safe.pop("alpaca_api_key", None)
    safe.pop("alpaca_secret_key", None)
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
    """Return daily bars and gap zones for charting."""
    username = get_current_user(request)
    state = get_user_state(username)
    user_dir = auth.get_user_data_dir(username)
    cfg = config.load_config(user_dir)
    fetcher = state.get("fetcher")

    symbol = symbol.upper()

    if not fetcher:
        raise HTTPException(status_code=400, detail="Scanner not initialized")

    # Fetch daily bars (use more data for chart scrolling)
    bars = await fetcher.fetch_daily_bars(symbol, cfg.get("lookback_days", 252))
    bar_data = [{"date": b.bar_date.isoformat(), "open": b.open, "high": b.high, "low": b.low, "close": b.close} for b in bars]

    # Get zones for this symbol
    zones = state["zones"].get(symbol, [])
    zone_data = [z.to_dict() for z in zones]

    return JSONResponse({"bars": bar_data, "zones": zone_data})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("scanner:app", host="0.0.0.0", port=port, reload=False)
