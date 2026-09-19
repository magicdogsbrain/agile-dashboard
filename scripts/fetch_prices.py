#!/usr/bin/env python3
"""Fetch Octopus Agile import + export rates into data/rates.json.

Run by .github/workflows/update-prices.yml (and usable locally).
Stdlib only — no dependencies. Idempotent: if the rates are unchanged the file
is not rewritten, so the workflow's commit step becomes a no-op.

Env/args:
  REGION            GSP letter A-P (default C), or pass as first argument.
  OUT               output path (default data/rates.json relative to repo root).
"""
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = "https://api.octopus.energy"
FALLBACK_IMPORT = "AGILE-24-10-01"
FALLBACK_EXPORT = "AGILE-OUTGOING-19-05-13"
VALID_REGIONS = set("ABCDEFGHJKLMNP")


def get_json(url: str, retries: int = 2):
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "AgileBoard/1.0 (github pages data snapshot)"})
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.load(res)
        except Exception as e:  # noqa: BLE001 - retry any transport error
            last = e
            if attempt < retries:
                import time
                time.sleep(2 * (attempt + 1))
    raise SystemExit(f"FAILED fetching {url}: {last}")


def discover_products():
    """Pick the newest live Agile import/export products so a tariff relaunch
    doesn't silently break the snapshot. Falls back to the known codes."""
    try:
        data = get_json(f"{BASE}/v1/products/?page_size=250", retries=0)
        now = datetime.now(timezone.utc)

        def live(p):
            to = p.get("available_to")
            return to is None or datetime.fromisoformat(to.replace("Z", "+00:00")) > now

        results = [p for p in data.get("results", []) if live(p) and p.get("brand") == "OCTOPUS_ENERGY"]
        imp = sorted((p for p in results if p.get("direction") == "IMPORT" and p["code"].startswith("AGILE-")),
                     key=lambda p: p.get("available_from") or "", reverse=True)
        exp = sorted((p for p in results if p.get("direction") == "EXPORT" and p["code"].startswith("AGILE-OUTGOING")),
                     key=lambda p: p.get("available_from") or "", reverse=True)
        return (imp[0]["code"] if imp else FALLBACK_IMPORT,
                exp[0]["code"] if exp else FALLBACK_EXPORT)
    except SystemExit:
        return FALLBACK_IMPORT, FALLBACK_EXPORT


def fetch_rates(product: str, region: str, period_from: str, period_to: str):
    tariff = f"E-1R-{product}-{region}"
    qs = urllib.parse.urlencode({"period_from": period_from, "period_to": period_to, "page_size": 1500})
    url = f"{BASE}/v1/products/{product}/electricity-tariffs/{tariff}/standard-unit-rates/?{qs}"
    data = get_json(url)
    rows = [
        {"from": r["valid_from"], "to": r["valid_to"], "price": r["value_inc_vat"]}
        for r in data.get("results", [])
    ]
    rows.sort(key=lambda r: r["from"])  # API returns newest-first
    return rows


def main():
    region = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("REGION", "C")).strip().upper()
    if region not in VALID_REGIONS:
        raise SystemExit(f"Invalid region {region!r} — must be one of {''.join(sorted(VALID_REGIONS))}")

    repo_root = Path(__file__).resolve().parent.parent
    out_path = Path(os.environ.get("OUT", repo_root / "data" / "rates.json"))

    now = datetime.now(timezone.utc)
    # Anchor the window to UTC midnights so consecutive same-day runs request
    # identical windows — a minute-sliding period_from changes the first row
    # every run and defeats the idempotence check below.
    period_from = (now - timedelta(days=2)).strftime("%Y-%m-%dT00:00Z")
    period_to = (now + timedelta(days=2)).strftime("%Y-%m-%dT00:00Z")

    import_product, export_product = discover_products()
    imp = fetch_rates(import_product, region, period_from, period_to)
    exp = fetch_rates(export_product, region, period_from, period_to)
    if not imp:
        raise SystemExit("No import rates returned — refusing to overwrite the snapshot")

    payload = {
        "region": region,
        "unit": "p/kWh (import inc VAT; export has no VAT)",
        "import": {"product": import_product, "rates": imp},
        "export": {"product": export_product, "rates": exp},
    }

    # Idempotence: compare everything except the timestamp.
    if out_path.exists():
        try:
            old = json.loads(out_path.read_text())
            old.pop("generated_at", None)
            if old == payload:
                print(f"No change (horizon {imp[-1]['to']}) — not rewriting {out_path}")
                return
        except (json.JSONDecodeError, OSError):
            pass

    payload["generated_at"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    print(f"Wrote {out_path}: {len(imp)} import + {len(exp)} export slots, horizon {imp[-1]['to']}")


if __name__ == "__main__":
    main()
