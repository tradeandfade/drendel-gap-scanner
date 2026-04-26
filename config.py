"""Per-user configuration management for the Drendel Gap Scanner."""

import json
from pathlib import Path

DEFAULT_CONFIG = {
    "alpaca_api_key": "",
    "alpaca_secret_key": "",
    "alpaca_base_url": "https://paper-api.alpaca.markets",
    "polygon_api_key": "",
    "fmp_api_key": "",
    "scanner_provider": "alpaca",
    "chart_provider": "alpaca",
    "scan_interval_seconds": 300,
    "lookback_days": 252,
    "max_gaps_per_symbol": 50,
    "alert_sensitivity": {
        "proximity_pct": 0.0,
    },
    "alert_filters": [],
    "ma_scanner": {
        "enabled": False,
        "moving_averages": [],
    },
    "ugly_gap": {
        "close_pct": 25,           # D1 close must be in bottom N% of D1 range
        "gap_pct": 50,             # D2 open must be at/above N% of D1 range
        "scan_interval_seconds": 15,   # cadence of Pass B during morning window
        "scan_window_minutes": 15,     # how many minutes after 9:30 to keep polling
    },
    "watchlists": {
        "Default": [],
    },
    "active_watchlists": ["Default"],
    "starred_symbols": [],
    "daily_reset_time": "09:00",
    "display": {
        "show_untested": True,
        "show_age": True,
        "compact_view": False,
    },
    "watchlist": [],
}


def _config_path(user_dir: Path) -> Path:
    return user_dir / "config.json"


def load_config(user_dir: Path) -> dict:
    path = _config_path(user_dir)
    if path.exists():
        try:
            with open(path, "r") as f:
                saved = json.load(f)
            cfg = _deep_merge(DEFAULT_CONFIG.copy(), saved)
            # Migrate legacy watchlist into watchlists["Default"]
            if cfg.get("watchlist") and not cfg.get("watchlists", {}).get("Default"):
                if "watchlists" not in cfg:
                    cfg["watchlists"] = {}
                cfg["watchlists"]["Default"] = cfg["watchlist"]
            return cfg
        except (json.JSONDecodeError, IOError):
            return DEFAULT_CONFIG.copy()
    return DEFAULT_CONFIG.copy()


def get_active_symbols(cfg: dict) -> list:
    """Get combined unique symbols from all active watchlists."""
    active = cfg.get("active_watchlists", ["Default"])
    all_wl = cfg.get("watchlists", {})
    symbols = set()
    for name in active:
        symbols.update(all_wl.get(name, []))
    # Also include legacy watchlist for backward compat
    symbols.update(cfg.get("watchlist", []))
    return sorted(list(symbols))


def save_config(user_dir: Path, config: dict) -> None:
    path = _config_path(user_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(config, f, indent=2)


def update_config(user_dir: Path, updates: dict) -> dict:
    config = load_config(user_dir)
    config = _deep_merge(config, updates)
    save_config(user_dir, config)
    return config


def _deep_merge(base: dict, override: dict) -> dict:
    result = base.copy()
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result
