# Drendel Gap Scanner — Complete Handover Notes

## Project Overview

A multi-user, self-hosted web dashboard that scans a stock watchlist for:
1. **Gap Zone Alerts** — detects when price enters support/resistance gap zones
2. **MA Crossover Alerts** — detects when price crosses configured moving averages

Built with Python/FastAPI backend, vanilla HTML/CSS/JS frontend, TradingView Lightweight Charts for charting.

---

## Tech Stack

- **Backend**: Python 3.11+ / FastAPI + Uvicorn
- **Data**: Alpaca Markets API (IEX feed — free tier), with Polygon.io and FMP support built but not yet wired for data fetching
- **Auth**: Cookie-based sessions, PBKDF2-SHA256 hashed passwords, multi-user
- **Frontend**: Vanilla HTML/CSS/JS, DM Sans + DM Mono fonts
- **Charts**: TradingView Lightweight Charts v4.1.0 (CDN)
- **Hosting**: Self-hosted (previously Railway, moved to local). `start.bat` for Windows startup
- **Repo**: https://github.com/tradeandfade/drendel-gap-scanner

---

## File Structure

```
drendel-gap-scanner/
├── scanner.py          # FastAPI app, all API routes, scan loop, per-user scanner instances
├── auth.py             # Multi-user auth, session management, PBKDF2 hashing
├── config.py           # Per-user config with defaults, multi-watchlist, get_active_symbols()
├── gap_engine.py       # Core gap zone logic: build zones, check alerts, update zones
├── ma_scanner.py       # MA crossover detection: track positions between scans, trend analysis
├── data_fetcher.py     # Alpaca API client: bars, prices, key validation (feed=iex)
├── polygon_fetcher.py  # Polygon.io API client (built, key storage works, data fetching not yet integrated)
├── fmp_fetcher.py      # FMP API client (built, key storage works, data fetching not yet integrated)
├── models.py           # Dataclasses: BarData, GapZone, Alert, ScannerStatus
├── utils.py            # Market hours check, ET timezone, logging setup
├── requirements.txt    # fastapi, uvicorn, httpx, pandas, python-dotenv
├── start.bat           # Windows startup script (installs deps, sets DATA_DIR, runs server)
├── Procfile            # Railway deployment (legacy)
├── railway.json        # Railway config (legacy)
├── static/
│   ├── index.html      # Main dashboard HTML
│   ├── login.html      # Login/register page
│   ├── style.css       # All styles — dark theme, olive/black/white palette
│   └── app.js          # All frontend JS — charts, alerts, settings, watchlist management
```

---

## Gap Zone Logic (gap_engine.py)

### Zone Creation
- **Support Gap (gap up)**: `Open_today > Close_yesterday` AND `Low_today > Close_yesterday`
  - Zone: bottom = Close_yesterday, top = Low_today
- **Resistance Gap (gap down)**: `Open_today < Close_yesterday` AND `High_today < Close_yesterday`
  - Zone: bottom = High_today, top = Close_yesterday

### Zone Classification
- Gaps are created as `untested_support` or `untested_resistance`
- **Critical**: Gaps are NOT tested on their creation day. The code processes existing zone updates BEFORE detecting new gaps in the daily bar loop
- A gap becomes `support` or `resistance` only when price revisits the zone on a **subsequent day**

### Zone Updates (on subsequent daily bars)
- **Support zone test**: Price close above zone top = holds. Close within zone = reduce zone top to close. Close below zone bottom = filled/removed
- **Resistance zone test**: Price close below zone bottom = holds. Close within zone = raise zone bottom to close. Close above zone top = filled/removed

### Zone Caching
- Zones are cached to `zones_cache.json` after every build and EOD update
- On login, cached zones load instantly for immediate dashboard display
- Background rebuild runs asynchronously to refresh with latest data

---

## MA Crossover Scanner (ma_scanner.py)

### Detection Logic
- Tracks each stock's **position relative to each MA** (`above` or `below`) between scan cycles
- On each scan: compute MA value, check if price is above/below
- If the side **changed** from the previous scan → crossover detected
- First scan of the day establishes positions (no alerts fire)
- **Dedup**: One alert per ticker per MA per day (regardless of direction — if it crosses and crosses back, only the first cross fires)

### MA Trend Detection
- Compares today's MA value to yesterday's MA value
- Rising: MA increased > 0.02%. Declining: decreased > 0.02%. Flat: within 0.02%

### Special Badges
- **Bullish Bounce**: Price crossing DOWN into a RISING MA
- **Bearish Rejection**: Price crossing UP into a DECLINING MA

### MA Stack Badge (computed in scanner.py scan cycle)
- **Bullish Stack** (▲ STACKED): 10 SMA > 20 SMA > 50 SMA > 200 SMA — shown on support gap cards
- **Bearish Stack** (▼ STACKED): 10 SMA < 20 SMA < 50 SMA < 200 SMA — shown on resistance gap cards
- Daily closes are fetched on-demand if not cached (tracked via `_closes_attempted` set to avoid re-fetching)

---

## Scanner Loop (scanner.py: `user_scan_loop`)

### Market Hours
- Scanner only polls prices during **9:30 AM - 4:00 PM ET** on weekdays
- Outside market hours, the loop sleeps but still checks for the daily reset

### Daily Reset + Zone Rebuild
- Fires at user's configured `daily_reset_time` (must be outside market hours — 4:00 PM to 9:30 AM)
- **Clears**: All gap alerts, MA alerts, fired_today dedup sets, ma_last_sides positions, daily_closes cache
- **Rebuilds**: Full zone rebuild from historical bars for all symbols (not incremental EOD — full fetch)
- Saves backup before clearing (for undo)

### Scan Cycle Flow
1. Fetch latest prices for all symbols in active watchlists
2. Run gap zone alert checks (proximity-based, one per zone per day)
3. Apply custom alert filters (MA-based conditions)
4. Compute MA stack badges (bullish/bearish)
5. Tag starred symbols
6. Run MA crossover checks (if enabled)
7. Persist alerts to disk

### Alert Dedup
- Gap alerts: One alert per zone per day (`fired_today` set with key `{symbol}_{zone_id}`)
- MA alerts: One alert per ticker per MA per day (`ma_fired_today` set with key `{symbol}_ma{period}_{type}`)

---

## Multi-User System (auth.py)

- `users.json` stored at `DATA_DIR/users.json`
- Each user's data at `DATA_DIR/userdata/{username}/config.json`
- Per-user scanner instances: `user_scanners[username]` dict
- Session cookie: `dgs_session`, httpOnly, 30-day expiry, PBKDF2-SHA256

---

## Configuration (config.py)

### Default Config Structure
```python
{
    "alpaca_api_key": "",
    "alpaca_secret_key": "",
    "alpaca_base_url": "https://paper-api.alpaca.markets",
    "polygon_api_key": "",          # Stored but not yet used for data
    "fmp_api_key": "",              # Stored but not yet used for data
    "scanner_provider": "alpaca",   # "alpaca", "polygon", or "fmp"
    "chart_provider": "alpaca",     # Same options
    "scan_interval_seconds": 300,
    "lookback_days": 252,
    "max_gaps_per_symbol": 50,
    "alert_sensitivity": {
        "proximity_pct": 0.0        # Single setting for both support/resistance
    },
    "alert_filters": [],            # List of {zone_type, condition, ma_period, ma_type}
    "ma_scanner": {
        "enabled": False,
        "moving_averages": []       # List of {period, type}
    },
    "watchlists": {"Default": []},  # Named watchlists
    "active_watchlists": ["Default"],
    "starred_symbols": [],          # Gold-themed alert cards
    "daily_reset_time": "09:00",    # Must be outside 9:30-16:00 ET
    "watchlist": []                 # Legacy — migrated to watchlists["Default"]
}
```

### get_active_symbols(cfg)
- Merges all active watchlists into a single sorted, deduplicated symbol list
- Also includes legacy `watchlist` field for backward compatibility

---

## API Endpoints

### Auth
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Serves login.html or index.html based on auth |
| GET | `/login` | Always serves login.html |
| GET | `/api/auth/status` | `{registered, authenticated, username}` |
| POST | `/api/auth/register` | Create account, auto-login |
| POST | `/api/auth/login` | Login, set cookie |
| POST | `/api/auth/logout` | Clear session |

### Scanner Data
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/alerts` | Gap alerts `{support:[], resistance:[], untested:[]}` with starred tags |
| GET | `/api/ma-alerts` | MA crossover alerts list |
| GET | `/api/zones` | All active zones with distance_pct |
| GET | `/api/status` | ScannerStatus (running, last_scan, last_eod_update, counts) |
| GET | `/api/chart/{symbol}?tf=1Day` | Bars + zones for charting. Timeframes: 1Min-1Week |

### Actions
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/alerts/clear` | Clear all gap alerts (saves backup for undo) |
| POST | `/api/alerts/restore` | Restore from backup |
| POST | `/api/star` | Toggle starred status `{symbol}` |
| POST | `/api/reinitialize` | Force scanner reinitialize |

### Settings & Watchlist
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/settings` | Config with keys masked |
| POST | `/api/settings` | Update config (validates reset time not during market hours) |
| GET | `/api/watchlist` | `{watchlist, watchlists, active_watchlists}` |
| POST | `/api/watchlist` | Save watchlist(s) + reinitialize |
| POST | `/api/watchlist/delete` | Delete a named watchlist (can't delete Default) |
| POST | `/api/setup` | Validate Alpaca keys + save + reinitialize |

### Debug
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/debug/ma/{symbol}` | MA values, crossover state, last_sides tracking for a symbol |

---

## Frontend Architecture (app.js)

### State Object
```javascript
{
    activeTab, alerts, zones, status, settings,
    refreshTimer, zoneSortCol, zoneSortDir, zoneFilter,
    alertFeed, previousAlertKeys,
    chart, volChart, chartSymbol, chartTf,
    filters, maConfigs, dismissedMA
}
```

### Key Functions
- `initLoad()` — Polls `/api/status` until initialized, shows loading screen
- `renderAlerts()` → `renderSec()` → `card()` — Gap alert rendering with vertical meters
- `renderMAAlerts()` — MA alerts split into sections by MA period, mini-cards
- `openChart()` — Creates dual-pane chart (78% price, 22% volume) with zones, MAs, OHLCV legend
- `chartPrev()/chartNext()` — Navigate between alert cards without closing chart (also arrow keys)
- `renderFilters()` — Custom alert filter builder UI
- `renderMAConfig()` — MA scanner configuration UI
- `renderWL()` — Watchlist with star buttons and tabs for multiple named watchlists
- `toggleStar()` — Toggle starred status via API

### Chart Features
- Dual-pane: candlesticks on top (78%), volume histogram below (22%)
- Synced time scales between panes
- OHLCV legend on crosshair hover (top-left of chart)
- White wicks on candles (bodies are green/red)
- Zone overlays: baseline series with fill between zone top and bottom
  - Support = green (90% border, 15% fill)
  - Resistance = red
  - Untested = blue
- 4 configurable MAs (10/20/50/200, SMA or EMA, custom colors)
- Timeframe selector: 1m, 5m, 15m, 30m, 1H, 4H, D, W
- Daily charts auto-zoom to last 52 weeks
- ◀ ▶ arrows + keyboard navigation between alert cards

### Alert Card Features
- Vertical meter bar showing price position within zone
- Support: fill from top (price entering from above)
- Resistance: fill from bottom
- Zone top/bottom labels adjacent to meter
- Badges: 1st test, multi-zone (2x, 3x), ▲ STACKED / ▼ STACKED
- **Starred stocks get gold theme**: gold border, text, meter, ★ prefix

---

## Visual Theme

### Color Palette
- Backgrounds: #080808 → #0e0e0e → #151515 → #1c1c1c
- Text: #eaeaea → #bbb → #888 → #666 → #444
- Accent: Olive green (#7c9a5e)
- Support: Green (#6aaa5c)
- Resistance: Red (#c45c4c)
- Untested: Blue (#5a8cc8)
- Starred: Gold (#d4a017)
- Fonts: DM Sans (UI), DM Mono (data/code)

### Cache Busting
- Static files use `?v=XX` query strings (currently v21)
- CacheControlMiddleware: static files max-age 60s, HTML/API no-store
- **IMPORTANT**: Bump the version number in index.html whenever CSS or JS changes

---

## Data Provider System

### Current: Alpaca (active)
- IEX feed (free tier), `feed=iex` parameter on all bar requests
- Supports all 8 timeframes for charts
- Intraday data limited by Alpaca's free tier retention (~5-7 days for minutes)

### Built but not integrated: Polygon.io
- `polygon_fetcher.py` — Complete API client
- Key storage and masking works
- Provider selection dropdown exists in settings
- **TODO**: Wire up data fetching to actually use Polygon when selected

### Built but not integrated: FMP
- `fmp_fetcher.py` — Complete API client with weekly aggregation
- Same status as Polygon — key storage works, data fetching not connected

### Provider Selection
- `scanner_provider` — Which API powers the scanner/zone builder
- `chart_provider` — Which API powers chart data (can be different)
- Falls back to Alpaca if selected provider validation fails

---

## Multi-Watchlist System

- Named watchlists stored in `watchlists` dict (e.g., "Default", "Tech", "Small Cap")
- Tab-based UI in settings to switch between watchlists
- Checkboxes to select which watchlists are active for scanning
- `get_active_symbols()` merges all active watchlists into one deduplicated list
- Can't delete "Default" watchlist
- Legacy `watchlist` field auto-migrated to `watchlists["Default"]`

---

## Alert Filter System

- User-created conditions stored in `alert_filters` list
- Each filter: `{zone_type: "support"|"resistance", condition: "above"|"below", ma_period: int, ma_type: "sma"|"ema"}`
- Evaluated in `_passes_filters()` during scan cycle
- Computes MA from cached daily closes, checks if price meets condition
- If any filter fails, the alert is suppressed

---

## Known Issues / TODOs

1. **Polygon/FMP data fetching** — API clients built, keys stored, but actual data fetching not wired up. Need to integrate into `_create_fetcher()` and chart endpoint properly.
2. **Intraday history** — Alpaca free tier has limited intraday retention. Polygon/FMP integration would fix this.
3. **Manually cleared alerts come back** — Clearing alerts is cosmetic; next scan cycle repopulates them if price is still in the zone. Need to add "dismissed zones" tracking if permanent clearing is desired.
4. **MA scanner first scan** — First scan after reset establishes positions but doesn't fire alerts. This is by design but can be confusing.
5. **Daily closes cache** — Only populated during full rebuild or on-demand fetch. If a symbol's closes aren't cached, MA stack badge won't show until fetched.

---

## Deployment Notes

### Self-Hosted (Current)
- Run `start.bat` on Windows
- Opens at `http://localhost:8000`
- `DATA_DIR` set to `./data` (relative to script location)
- Computer must be on during market hours for scanner to work

### Railway (Previous)
- `DATA_DIR=/app/data` (volume mount)
- Volume must be attached and mounted before app starts (60s wait logic in lifespan)
- Push with `git push origin main`
- CacheControlMiddleware handles static file caching

### Git
- Repo: https://github.com/tradeandfade/drendel-gap-scanner
- Default branch: `main`
- Normal push only (no --force to preserve volume data if using Railway)
