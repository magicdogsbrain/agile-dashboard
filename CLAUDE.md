# Agile Board — project notes for Claude

Static, no-build dashboard for Octopus Agile (import) + Agile Outgoing (export).
Owner has **no solar/battery yet**; phase 2 adds FoxESS Cloud via a Cloudflare
Worker proxy (FoxESS has no CORS and a secret signing key — never call it client-side).

## Architecture decisions (researched + live-verified 2026-09-03)

- Hybrid data: browser fetches api.octopus.energy directly (public, CORS `*`),
  falls back to committed `data/rates.json` (GitHub Action, cron `5 15,16,18 * * *`),
  then to `window.EMBEDDED_RATES` (artifact preview builds).
- Charts: ECharts 6.1.0 pinned from cdnjs. Import = custom-series rect per slot
  coloured by shared bands; export = step:'end' line **with duplicated terminal
  point** (else the last slot vanishes). `filterMode:'none'`, charts connected.
- One `bandOf(price)` (advisor.js, thresholds in config.js) feeds BOTH chart
  colours and advisor verdicts so they can never contradict.
- Advisor: prefix-sum cheapest contiguous window; percentile banding clamped by
  absolute anchors; guards for negative prices (no % when costNow ≤ 0.1p),
  windows that don't fit the horizon, and the pre-16:00 "tomorrow unknown" state.
  All economics go through the CostModel seam for phase 2.

## Invariants — do not break

- API returns rates **newest-first**: sort ascending at every ingest point.
- Never do slot index arithmetic: DST days have 46/50 slots. Times come from
  `valid_from`/`valid_to` epochs; display pinned to `Europe/London` via Intl.
- Agile day boundary is 23:00 **local** (22:00Z BST / 23:00Z GMT) — never
  hardcode a Z-hour; `AgileTime.coversTomorrow` compares London calendar dates.
- Import can be negative; export floored at 0 with no VAT. Display `value_inc_vat`.
- Product codes rotate: discovery first, pinned fallback second (js/api.js and
  scripts/fetch_prices.py must stay in sync on this logic).
- Plain scripts, no modules — the page must keep working from `file://`.
- localStorage is wrapped in try/catch (private browsing) — keep it that way.

## Style

Design tokens in css/styles.css (light base, dark via guarded media query +
`data-theme` override — artifact-compatible). Chart chrome reads the tokens via
getComputedStyle, so theming changes only ever touch the CSS.
