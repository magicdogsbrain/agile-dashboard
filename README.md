# ⚡ Agile Board

A static dashboard for the **Octopus Agile** import tariff and **Agile Outgoing** export
tariff: live half-hourly prices, interactive zoomable charts, and a plain answer to
*"is now a good time to run the dryer?"* — with the cheapest upcoming window if it isn't.

No build step, no backend, no API key. Works from GitHub Pages or by opening
`index.html` straight from disk.

## How it works

- The browser fetches prices directly from the public Octopus API
  (`api.octopus.energy` is CORS-open and needs no auth).
- A scheduled **GitHub Action** (`.github/workflows/update-prices.yml`) also commits a
  snapshot to `data/rates.json` three times a day around the ~4pm price publication.
  The page falls back to that snapshot if the live API is unreachable, and the same
  pipeline is the foundation phase 2 (FoxESS) will need.
- The advisor finds the cheapest contiguous window of your appliance's duration in the
  known price horizon (prefix-sum sliding window), grades "now" by percentile against
  the next 24h clamped by absolute price anchors, and words a recommendation —
  including the caveats that matter (before ~4pm tomorrow's prices don't exist yet;
  negative "plunge" prices mean you're paid to use power).

## Setup (one time)

1. Create a GitHub repository and push this folder to `main`.
2. **Settings → Pages → Deploy from a branch → `main` / `(root)`.**
3. Optionally set your region for the snapshot: **Settings → Secrets and variables →
   Actions → Variables → new variable** `AGILE_REGION` = your GSP letter (A–P, no I/O).
   Visitors can always switch region in the UI (postcode lookup included); the
   variable only controls what the committed fallback snapshot contains.
4. Run the **Update Agile prices** workflow once by hand (Actions tab → Run workflow)
   to create the first `data/rates.json`.

## Region

Agile prices differ by distribution region. The UI resolves yours from a postcode
(`/v1/industry/grid-supply-points/`) or a dropdown, and remembers it in
`localStorage`. Default is `C` (London).

## Project layout

```
index.html                    page shell
css/styles.css                design tokens (light + dark) and components
js/config.js                  tariff codes, price bands, appliance defaults, tuning
js/timeutil.js                Europe/London helpers (DST-safe; slots come from API epochs)
js/advisor.js                 pure "run it now?" engine + CostModel seam for phase 2
js/api.js                     Octopus API client: live → snapshot → embedded fallback
js/charts.js                  ECharts: per-slot import rects, stepped export line
js/app.js                     state, DOM, refresh loops
scripts/fetch_prices.py       snapshot fetcher (stdlib only) used by the Action
data/rates.json               committed price snapshot (bot-updated)
```

## Phase 2 — solar + battery (FoxESS)

Planned, deliberately not built yet:

- **FoxESS Cloud cannot be called from the browser** (no CORS, and the API key signs
  every request). The plan is a ~50-line Cloudflare Worker holding the key as a
  secret, exposing one cached JSON endpoint: `{soc, pvPower, loadsPower, gridImport,
  gridExport, batteryPower}`. FoxESS allows 1,440 calls/day per inverter — the Worker
  caches 60–120s so the dashboard can't burn the quota.
- The advisor already routes all economics through a cost-model seam
  (`advisor.js`): phase 2 swaps in marginal costs — running an appliance during PV
  surplus costs the *export* rate you forgo; running from battery costs the price it
  was charged at ÷ round-trip efficiency; otherwise the import rate. Banding and the
  cheapest-window search then just work on "effective price for this house".

## Notes & gotchas encoded in this code

- The API returns rates **newest-first**; everything sorts ascending on ingest.
- All slot math uses the API's UTC epochs. DST changeover days have **46 or 50**
  slots — nothing assumes 48, and display conversion is pinned to `Europe/London`.
- The Agile "day" ends 23:00 UK local; next-day prices appear ~16:00 UK (the page
  polls faster from 4pm until they land, and says so in the UI).
- Import can go **negative** (plunge pricing); export is floored at 0p and carries
  no VAT (`value_inc_vat == value_exc_vat`).
- Product codes rotate (`AGILE-24-10-01` is current). Both the page and the fetch
  script discover the newest live Agile products at runtime and fall back to the
  pinned codes.

Prices from the public [Octopus Energy API](https://developer.octopus.energy/).
Unofficial — always check your own tariff in your Octopus account.

## Home Assistant automation

`homeassistant/agile_appliances.yaml` is a drop-in HA package that pairs with
this dashboard: it powers appliances up in the cheapest windows (via the
BottlecapDave Octopus Energy integration's target-rate sensors, configured to
the same presets as the dashboard) and **never cuts power mid-cycle** — a
power-monitoring smart plug plus a debounced "idle" sensor gates every
switch-off, so the schedule opens the window but only a finished cycle closes
it. Setup instructions are in the file's header.
