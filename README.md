# Drendel Gap Scanner

A live dashboard that scans your stock watchlist for price entries into support and resistance gap zones.

## One-Click Deploy (No Terminal Required)

Click the button below to deploy your own private scanner instance:

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/YOUR_TEMPLATE_ID)

> **Replace `YOUR_TEMPLATE_ID`** with your actual Railway template ID after creating the template (see Sharing section below).

After clicking:
1. Railway will ask you to sign in (free account)
2. It deploys automatically — takes about 60 seconds
3. You get a URL like `your-scanner.up.railway.app`
4. Open it, create your account, enter your Alpaca keys, add your watchlist
5. Done. Scanner is running.

**No terminal. No code. No installs.**

## What It Does

- Monitors your custom watchlist in real time
- Calculates all unfilled support & resistance gap zones from daily data
- Alerts on the dashboard when price enters a gap zone
- Tracks zone reductions and fills automatically
- Configurable sensitivity (alert on zone entry, or within X% of a zone)
- Password-protected — only you can see your data

## How Gap Zones Work

**Support Gaps** form when a stock gaps up and doesn't fill back down. The zone between the previous close and the gap day's low becomes potential support.

**Resistance Gaps** form when a stock gaps down and doesn't fill back up. The zone between the gap day's high and the previous close becomes potential resistance.

Zones are tested, reduced, or filled as price interacts with them over time.

## For Developers: Local Setup

If you prefer to run it locally:

```bash
git clone https://github.com/YOUR_USERNAME/drendel-gap-scanner.git
cd drendel-gap-scanner
pip install -r requirements.txt
python scanner.py
# Open http://localhost:8000
```

## Sharing With Your Group

### Creating a Railway Template (one-time setup)

1. Push this repo to your GitHub
2. Deploy it on Railway yourself first
3. In Railway, go to your project settings and click "Create Template"
4. This gives you a template URL with a deploy button
5. Share that URL in your Discord — each person clicks it to get their own instance

### What Each Person Gets

- Their own private server (no shared data)
- Their own login (username + password)
- Their own Alpaca API keys (stored only on their server)
- Their own watchlist and settings

No one can see anyone else's data. Each instance is completely isolated.

## Security

- Passwords are hashed with PBKDF2-SHA256 + random salt
- API keys are stored in a local JSON file on the server only
- Session cookies are httpOnly (not accessible via JavaScript)
- Each instance is single-user (one account per deployment)
- No data is sent to any third party

## Configuration

All settings are configurable in the browser via the Settings tab:

| Setting | Default | Description |
|---------|---------|-------------|
| Refresh Interval | 5 min | How often to check prices (15s / 30s / 1m / 5m) |
| Support Proximity | 0% | Alert threshold (0 = zone entry only) |
| Resistance Proximity | 0% | Alert threshold (0 = zone entry only) |
| Lookback Days | 252 | History to scan (~1 trading year) |
| Max Gaps/Symbol | 50 | Limit per symbol |

## Tech Stack

- **Backend**: Python 3.11+ / FastAPI
- **Data**: Alpaca Markets API (free tier)
- **Frontend**: Vanilla HTML/CSS/JS
- **Auth**: Cookie-based with hashed passwords
- **Hosting**: Railway (one-click deploy)

## License

MIT
