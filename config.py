"""Per-user configuration management for the Drendel Gap Scanner."""

import json
from pathlib import Path

DEFAULT_CONFIG = {
    "alpaca_api_key": "",
    "alpaca_secret_key": "",
    "alpaca_base_url": "https://paper-api.alpaca.markets",
    "polygon_api_key": "",
    "fmp_api_key": "",
    "scan_interval_seconds": 300,
    "lookback_days": 252,
    "max_gaps_per_symbol": 50,
    "alert_sensitivity": {
        "proximity_pct": 0.0,
    },
    "alert_filters": [],
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
            return _deep_merge(DEFAULT_CONFIG.copy(), saved)
        except (json.JSONDecodeError, IOError):
            return DEFAULT_CONFIG.copy()
    return DEFAULT_CONFIG.copy()


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
