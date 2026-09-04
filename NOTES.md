# Project notes — decisions & research findings

Working notes for Agile Board. Figures verified against live data on the dates
shown; revisit yearly (anchors drift with wholesale prices).

## Tariff decision (analysed 2026-09-03)

**Agile beats the price cap even with NO behaviour change, no solar, no
battery.** Computed from 12 months of actual half-hourly Agile prices
(Sep 2025 – Sep 2026, region C, via the public API):

| Scenario | p/kWh |
|---|---|
| Price cap (SVT) unit rate — Jul–Sep 2026 / Oct–Dec 2026 | 26.11 / 26.32 |
| Agile, typical evening-peaked home, **zero shifting** | **21.4** |
| Agile with modest shifting (⅓ of 4–7pm load → cheap windows) | **19.6** |
| Agile flat average of all half-hours | 19.2 |

- ≈ **18% cheaper per unit with no effort** — ~£130/yr on a 2,700kWh home,
  ~£175–190/yr with modest shifting; scales with usage.
- Downside is bounded: the worst full month (Aug 2026, 27.2p weighted) roughly
  **matched** the cap; 410 negative-price half-hours in the year vs only 11
  half-hours above 60p; Agile's own cap is 100p/kWh; switching back to
  Flexible/Tracker takes days with no exit fee.
- Electricity is **VAT-free 1 Oct 2026 – 31 Mar 2027** (applies to all
  tariffs, so the comparison holds).

**Plan: switch to Agile a few days before the solar install.** Checklist for
that week: confirm half-hourly smart-meter reads are flowing a month ahead
(can take weeks to enable); expect Agile Outgoing to lag the install (needs
MCS cert + export MPAN — days to weeks of exporting unpaid).

## Plug-in battery (optional accelerator)

Socket-connected LiFePO4 arbitrage (no solar needed): e.g. Marstek Venus E
5.12kWh, ~£1,000–1,300, 800W via socket / 2.5kW hardwired, native Octopus
price-following AI mode + local Home Assistant integrations. Rough economics
on last year's prices: ~£200–260/yr on top of the no-shift saving, ~4–6 year
payback vs ~16-year cycle life. Needs G98/DNO notification and an insurer
heads-up. **Skipped for now** since the full solar+battery (FoxESS) install is
coming; reconsider only if that slips badly.

## Home Assistant layer (packages in `homeassistant/`)

- `agile_appliances.yaml` — appliances run in the cheapest windows via
  BottlecapDave target-rate sensors; a debounced power-draw "idle" sensor
  gates every switch-off so a running cycle is NEVER interrupted (delayed
  start for wet appliances; immersion is interruptible and follows prices
  directly; notification-only safety net during spikes).
- `agile_price_light.yaml` — ambient colour bulb painted with the dashboard's
  exact price bands (blue cheap → red peak, pulsing deep blue on plunge),
  daytime only; optional Awtrix pixel-clock app showing the pence figure.

## Hardware shortlist

- **Smart plugs**: TP-Link **Tapo P110** 4-pack (~£8/plug, 13A, energy
  monitoring, local HA). Premium single: Shelly Plus Plug UK (13A/3kW).
  **Avoid** Shelly Plug S (10A — too low for a 3kW dryer) and no-name Tuya on
  heating loads. Wall socket, not extension lead; check plug stays cool.
- **Immersion**: wired Shelly/contactor, never a 13A plug.
- **Price display**: Ulanzi TC001 + Awtrix 3 (~£40); cheaper DIY = ESP32 +
  8×32 WS2812B matrix (~£12–18, same Awtrix firmware); lowest power =
  OpenEPaperLink e-shelf-label (milliwatts, coin cell, no glow); middle =
  LilyGO T-Display S3 + ESPHome (~£12). Pairing that works: £10 colour bulb
  for the glance + e-paper tag for the number.
- **FoxESS Modbus (phase 2)**: Waveshare **RS485 TO ETH (B)** wired —
  preferred; the RS485 TO WIFI/ETH variant exists if no cable run is possible
  (WiFi serial bridges are the top cause of Modbus dropouts). Two wires to
  the inverter's 485A/485B; `foxess_modbus` HA integration; no cloud, no
  quota.

## Automation status

- GitHub Action's first scheduled run (2026-09-03 15:05 UTC) committed
  tomorrow's prices unattended — pipeline confirmed working end to end.
