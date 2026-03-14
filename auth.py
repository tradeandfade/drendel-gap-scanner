"""Multi-user authentication for the Drendel Gap Scanner.

Each user has their own account with isolated config, watchlist, and zones.
Passwords hashed with PBKDF2-SHA256 + random salt.
"""

import hashlib
import json
import os
import secrets
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "."))
AUTH_PATH = DATA_DIR / "users.json"
SESSION_COOKIE = "dgs_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 30  # 30 days


def _hash_password(password: str, salt: str = None) -> tuple[str, str]:
    if salt is None:
        salt = secrets.token_hex(16)
    hashed = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000).hex()
    return hashed, salt


def _load_users() -> dict:
    if AUTH_PATH.exists():
        try:
            with open(AUTH_PATH, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return {}


def _save_users(data: dict):
    AUTH_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(AUTH_PATH, "w") as f:
        json.dump(data, f, indent=2)


def register(username: str, password: str) -> tuple[bool, str]:
    if len(username) < 3:
        return False, "Username must be at least 3 characters."
    if len(password) < 6:
        return False, "Password must be at least 6 characters."

    users = _load_users()
    if username.lower() in users:
        return False, "Username already taken. Choose a different one."

    hashed, salt = _hash_password(password)
    users[username.lower()] = {
        "username": username,
        "password_hash": hashed,
        "salt": salt,
        "session_token": None,
    }
    _save_users(users)
    return True, "Account created successfully."


def verify_login(username: str, password: str) -> tuple[bool, str]:
    users = _load_users()
    user = users.get(username.lower())
    if not user:
        return False, "Invalid username or password."

    hashed, _ = _hash_password(password, user["salt"])
    if hashed != user["password_hash"]:
        return False, "Invalid username or password."

    token = secrets.token_hex(32)
    user["session_token"] = token
    _save_users(users)
    return True, token


def verify_session(token: str) -> str | None:
    """Returns the username if session is valid, None otherwise."""
    if not token:
        return None
    users = _load_users()
    for uname, user in users.items():
        if user.get("session_token") == token:
            return uname
    return None


def logout(token: str):
    if not token:
        return
    users = _load_users()
    for uname, user in users.items():
        if user.get("session_token") == token:
            user["session_token"] = None
            _save_users(users)
            return


def get_user_data_dir(username: str) -> Path:
    """Get the data directory for a specific user."""
    user_dir = DATA_DIR / "userdata" / username.lower()
    user_dir.mkdir(parents=True, exist_ok=True)
    return user_dir
