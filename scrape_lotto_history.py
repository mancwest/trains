#!/usr/bin/env python3
"""
scrape_lotto_history.py

Pulls the full published history of NZ Lotto draws (main numbers, bonus ball,
and Powerball where applicable) from lottoresults.co.nz's public monthly
archive pages, and writes it to a CSV file that the Lotto Number Lab app reads.

WHY A SEPARATE SCRIPT
Claude can't run a long-lived scraper against the live internet from inside
the chat -- and pulling ~470 months of archive pages is genuinely a lot of
requests, so it belongs in a script you run yourself, at your own pace, with
your own network.

WHAT IT DOES
- Walks month-by-month from Lotto NZ's first draw (August 1987) to the
  current month.
- For each month page, extracts every draw's date, draw number, jackpot
  status, the 6 main numbers, the bonus ball, and the Powerball (where the
  game had Powerball on offer).
- Writes everything to data/nz_lotto_history.csv, one row per draw.
- Is resumable: it checkpoints completed months to
  scripts/.scrape_progress.json, so re-running after an interruption picks
  up where it left off instead of re-fetching everything.
- Rate-limits itself (default: 1.5s between requests) to be a reasonable
  citizen towards the site it's reading from.

USAGE
    python scripts/scrape_lotto_history.py
    python scripts/scrape_lotto_history.py --start-year 2015 --end-year 2026
    python scripts/scrape_lotto_history.py --delay 2.5
    python scripts/scrape_lotto_history.py --fresh   # ignore checkpoint, redo everything

REQUIREMENTS
    pip install requests beautifulsoup4

A NOTE ON ACCURACY AND SOURCES
This reads a third-party archive (lottoresults.co.nz), not Lotto NZ's own
API -- Lotto NZ doesn't publish one. The parser is deliberately defensive
(it skips anything that doesn't look like a clean 6-number draw rather than
guessing), but you should treat this as "good enough for statistical
exploration", not as an authoritative record. For anything that matters
(checking a ticket, verifying a specific jackpot), always use
https://mylotto.co.nz directly.

This script only reads public pages for personal, non-commercial, statistical
analysis. It doesn't bypass any access controls. If you plan to run it a lot,
please keep the delay reasonable and don't hammer the site.
"""

import argparse
import csv
import json
import logging
import re
import sys
import time
from datetime import date, datetime
from pathlib import Path

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print(
        "Missing dependencies. Install them first:\n"
        "    pip install requests beautifulsoup4",
        file=sys.stderr,
    )
    sys.exit(1)


BASE_URL = "http://lottoresults.co.nz/lotto/{month}-{year}"
MONTH_NAMES = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
]
LOTTO_START_YEAR = 1987
LOTTO_START_MONTH = 8  # August 1987 -- Lotto NZ's first draw

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; NZLottoLabScraper/1.0; "
        "personal statistical research; contact: n/a)"
    )
}

RESULT_HEADING_RE = re.compile(r"^Lotto Result for (\w+), (\d{1,2} \w+ \d{4})$")
DRAW_NUMBER_RE = re.compile(r"^Draw Number:\s*(\d+)$")
JACKPOT_RE = re.compile(r"^Jackpot:\s*(.+)$")
PURE_NUMBER_RE = re.compile(r"^\d{1,2}$")

CSV_FIELDS = [
    "date", "draw_number", "jackpot_status",
    "m1", "m2", "m3", "m4", "m5", "m6", "bonus", "powerball",
]


def build_session():
    session = requests.Session()
    session.headers.update(HEADERS)
    try:
        from requests.adapters import HTTPAdapter
        from urllib3.util.retry import Retry
        retries = Retry(total=3, backoff_factor=1.0, status_forcelist=[500, 502, 503, 504])
        session.mount("http://", HTTPAdapter(max_retries=retries))
        session.mount("https://", HTTPAdapter(max_retries=retries))
    except Exception:
        pass  # fine without retry mounting, just less resilient
    return session


def parse_month_page(html):
    """Parse one month's archive page into a list of draw dicts."""
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text("\n", strip=True)
    lines = text.split("\n")

    draws = []
    i = 0
    current_date = None
    while i < len(lines):
        line = lines[i]

        heading_match = RESULT_HEADING_RE.match(line)
        if heading_match:
            weekday, date_str = heading_match.groups()
            try:
                current_date = datetime.strptime(date_str, "%d %B %Y").date()
            except ValueError:
                current_date = None
            i += 1
            continue

        draw_num_match = DRAW_NUMBER_RE.match(line)
        if draw_num_match and current_date is not None:
            draw_number = draw_num_match.group(1)

            # Look ahead for the Jackpot line (should be very close)
            jackpot_status = ""
            j = i + 1
            while j < len(lines) and j < i + 4:
                jm = JACKPOT_RE.match(lines[j])
                if jm:
                    jackpot_status = jm.group(1)
                    j += 1
                    break
                j += 1

            # Collect the next run of pure-number lines: expect
            # [m1..m6, bonus, powerball, (strike numbers...)]
            numbers = []
            k = j
            while k < len(lines) and len(numbers) < 8:
                if PURE_NUMBER_RE.match(lines[k]):
                    numbers.append(int(lines[k]))
                    k += 1
                elif lines[k] == "" or lines[k].startswith("!["):
                    k += 1
                else:
                    break

            if len(numbers) >= 6:
                mains = numbers[0:6]
                bonus = numbers[6] if len(numbers) >= 7 else ""
                powerball = numbers[7] if len(numbers) >= 8 else ""

                # Sanity checks -- skip anything that doesn't look right
                # rather than writing bad data.
                valid = (
                    len(mains) == 6
                    and all(1 <= n <= 40 for n in mains)
                    and len(set(mains)) == 6
                    and (bonus == "" or 1 <= bonus <= 40)
                    and (powerball == "" or 1 <= powerball <= 14)
                )
                if valid:
                    draws.append({
                        "date": current_date.isoformat(),
                        "draw_number": draw_number,
                        "jackpot_status": jackpot_status,
                        "m1": mains[0], "m2": mains[1], "m3": mains[2],
                        "m4": mains[3], "m5": mains[4], "m6": mains[5],
                        "bonus": bonus,
                        "powerball": powerball,
                    })
                else:
                    logging.warning(
                        "Skipping draw %s on %s -- numbers didn't validate: %s",
                        draw_number, current_date, numbers,
                    )
            i = k
            continue

        i += 1

    return draws


def load_progress(progress_path):
    if progress_path.exists():
        try:
            return set(json.loads(progress_path.read_text()))
        except (json.JSONDecodeError, OSError):
            return set()
    return set()


def save_progress(progress_path, completed):
    progress_path.write_text(json.dumps(sorted(completed)))


def load_existing_dates(csv_path):
    """So we never write duplicate rows even if a month gets re-scraped."""
    if not csv_path.exists():
        return set()
    seen = set()
    with csv_path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            seen.add(row["date"])
    return seen


def iter_months(start_year, end_year):
    today = date.today()
    for year in range(start_year, end_year + 1):
        for month_index, month_name in enumerate(MONTH_NAMES, start=1):
            if year == LOTTO_START_YEAR and month_index < LOTTO_START_MONTH:
                continue
            if year == today.year and month_index > today.month:
                continue
            if year > today.year:
                continue
            yield year, month_index, month_name


def main():
    parser = argparse.ArgumentParser(description="Scrape NZ Lotto draw history into a CSV.")
    parser.add_argument("--start-year", type=int, default=LOTTO_START_YEAR)
    parser.add_argument("--end-year", type=int, default=date.today().year)
    parser.add_argument("--output", type=str, default="data/nz_lotto_history.csv")
    parser.add_argument("--delay", type=float, default=1.5, help="Seconds between requests.")
    parser.add_argument("--fresh", action="store_true", help="Ignore checkpoint, refetch all months.")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s  %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    progress_path = Path(__file__).parent / ".scrape_progress.json"

    completed_months = set() if args.fresh else load_progress(progress_path)
    existing_dates = set() if args.fresh else load_existing_dates(output_path)

    write_header = args.fresh or not output_path.exists()
    mode = "w" if args.fresh else "a"

    session = build_session()
    total_new = 0
    months = list(iter_months(args.start_year, args.end_year))
    logging.info("Planning to check %d months (%d-%d).", len(months), args.start_year, args.end_year)

    with output_path.open(mode, newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        if write_header:
            writer.writeheader()

        for year, month_index, month_name in months:
            key = f"{year}-{month_index:02d}"
            if key in completed_months:
                logging.debug("Skipping %s (already done).", key)
                continue

            url = BASE_URL.format(month=month_name, year=year)
            try:
                resp = session.get(url, timeout=15)
            except requests.RequestException as exc:
                logging.warning("Request failed for %s: %s -- will retry on next run.", key, exc)
                time.sleep(args.delay)
                continue

            if resp.status_code == 404:
                logging.debug("No page for %s (404) -- treating as no draws that month.", key)
                completed_months.add(key)
                save_progress(progress_path, completed_months)
                time.sleep(args.delay)
                continue

            if resp.status_code != 200:
                logging.warning("Unexpected status %s for %s -- will retry on next run.", resp.status_code, key)
                time.sleep(args.delay)
                continue

            draws = parse_month_page(resp.text)
            new_rows = [d for d in draws if d["date"] not in existing_dates]

            for row in new_rows:
                writer.writerow(row)
                existing_dates.add(row["date"])
            f.flush()

            total_new += len(new_rows)
            logging.info(
                "%s: found %d draws (%d new). Running total this session: %d",
                key, len(draws), len(new_rows), total_new,
            )

            completed_months.add(key)
            save_progress(progress_path, completed_months)
            time.sleep(args.delay)

    logging.info("Done. %d new draws written to %s", total_new, output_path)
    logging.info(
        "Tip: re-run any time to pick up new draws (delete scripts/.scrape_progress.json "
        "or pass --fresh to force a full re-scrape)."
    )


if __name__ == "__main__":
    main()
