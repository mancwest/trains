# Lotto Number Lab

A statistics and expected-value toolkit for NZ Lotto — built to be genuinely
useful without pretending to predict a random draw.

**Read this first:** every NZ Lotto draw uses an independently audited random
number generator with no memory of past draws. Nothing in this repo —
including the "popularity-avoiding" generator — improves your odds of
winning. What it *can* do honestly:

1. **Explore real historical draws** — frequency, pairings, Powerball trends.
2. **Audit the draw for statistical bias** — a proper chi-square
   goodness-of-fit test against what a fair, uniform draw should look like.
3. **Avoid splitting a jackpot with other players** — a real, published
   effect: humans over-pick birthday numbers (1–31) and slip patterns, so
   avoiding those numbers doesn't raise your odds, but *does* raise your
   expected payout *if* you win, because you're less likely to share the
   prize pool.
4. **See the actual expected value** of a ticket, using Lotto NZ's real
   published odds and payout ratio — not marketing copy.

## Project layout

```
nz-lotto-lab/
├── index.html                     the app
├── style.css
├── app.js                         all the logic (stats, audit, EV, generators)
├── data/
│   └── nz_lotto_history.csv       draw history (ships with a real Apr–Sep 2026 sample)
└── scripts/
    └── scrape_lotto_history.py    run this yourself to pull the full 1987–present history
```

## Getting the full historical dataset

The app ships with a small real sample (47 draws, April–September 2026) so
it works immediately. For the full history back to Lotto NZ's first draw in
August 1987, run the scraper yourself:

```bash
pip install requests beautifulsoup4
python scripts/scrape_lotto_history.py
```

This walks month-by-month through a public draw archive, writes everything
to `data/nz_lotto_history.csv`, and checkpoints its progress — so if it gets
interrupted (or you Ctrl-C it), just run it again and it picks up where it
left off. With the default 1.5s delay between requests, expect the full
~470-month walk to take a while (roughly 15–20 minutes) — that's deliberate,
to be a reasonable citizen towards the site it reads from.

```bash
# Useful variations:
python scripts/scrape_lotto_history.py --start-year 2015     # partial history, faster
python scripts/scrape_lotto_history.py --delay 3.0           # gentler on the source site
python scripts/scrape_lotto_history.py --fresh               # ignore checkpoint, redo everything
```

The scraper reads a third-party public archive (Lotto NZ doesn't publish an
API), so treat the result as good for statistics, not as an authoritative
record — always check **mylotto.co.nz** for anything that actually matters
(checking a ticket, confirming a jackpot).

## Running the app

Because the app loads `data/nz_lotto_history.csv` via `fetch()`, opening
`index.html` directly as a `file://` URL will usually fail (browsers block
local file fetches for security). Two easy ways around that:

**Option A — GitHub Pages** (recommended, since you're pushing this to
GitHub anyway): Settings → Pages → deploy from the `main` branch. Your app
will be live at `https://<you>.github.io/<repo>/`.

**Option B — a local server**, from the project folder:
```bash
python -m http.server 8000
# then open http://localhost:8000
```

## An important note on timing

**Powerball's pool is expanding from 10 to 14 numbers on 13 September
2026** (Lotto-only odds are unaffected). The app already accounts for this —
it applies the correct pool size to each draw based on its date, and the
generators/EV calculator use whichever pool size is current "today." If
you're reading this well after that date, nothing to do; it's handled.

## What this deliberately does *not* do

It does not claim any number is "due," does not weight predictions on
streaks, and does not offer a "winning numbers" feature. Every generator
in this app produces numbers that are exactly as likely to win as any other
combination — the only thing that differs between them is who else might
have picked the same ticket.
