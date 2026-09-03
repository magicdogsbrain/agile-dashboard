/* Agile Board — configuration.
   Everything a future tariff relaunch or phase-2 (solar/battery) change touches lives here. */
window.AGILE_CONFIG = {
  api: {
    base: 'https://api.octopus.energy',
    // Product codes verified live 2026-09-03. Product codes rotate (AGILE-18-02-21 ->
    // AGILE-22-* -> AGILE-24-10-01), so the app also tries live discovery at startup
    // (see api.js discoverProducts) and falls back to these.
    importProduct: 'AGILE-24-10-01',
    exportProduct: 'AGILE-OUTGOING-19-05-13',
    // Tariff code pattern: E-1R-<PRODUCT>-<REGION>
    tariffCode: (product, region) => `E-1R-${product}-${region}`,
    snapshotUrl: 'data/rates.json',
  },

  // GSP group letters (no I or O). DNO area names are the industry-standard GSP
  // group mapping — the API only returns the letter.
  regions: {
    A: 'Eastern England', B: 'East Midlands', C: 'London',
    D: 'Merseyside & N. Wales', E: 'West Midlands', F: 'North East England',
    G: 'North West England', H: 'Southern England', J: 'South East England',
    K: 'South Wales', L: 'South West England', M: 'Yorkshire',
    N: 'South Scotland', P: 'North Scotland',
  },
  defaultRegion: 'C',

  // Shared price bands (p/kWh inc VAT) — the single source of truth used by BOTH
  // the charts and the advisor, so a slot's colour never contradicts its verdict.
  // Diverging scale: cheap = cool blues, expensive = hot reds, neutral midpoint.
  bands: [
    { max: 0,        id: 'plunge',  label: 'Plunge (paid to use)', light: '#0d366b', dark: '#b7d3f6' },
    { max: 10,       id: 'vcheap',  label: 'Very cheap',           light: '#1c5cab', dark: '#86b6ef' },
    { max: 18,       id: 'cheap',   label: 'Cheap',                light: '#5598e7', dark: '#5598e7' },
    { max: 27,       id: 'typical', label: 'Typical',              light: '#b3b2aa', dark: '#4c4c49' },
    { max: 35,       id: 'high',    label: 'High',                 light: '#dd8074', dark: '#c96a5e' },
    { max: 45,       id: 'vhigh',   label: 'Very high',            light: '#d03b3b', dark: '#e66767' },
    { max: Infinity, id: 'extreme', label: 'Extreme',              light: '#8a1f1f', dark: '#f09a9a' },
  ],

  // Verdict scale for the advisor (status colours are reserved for state, always
  // paired with icon + label — never colour alone).
  verdicts: {
    great: { label: 'Great time', icon: '✓✓', color: '#0ca30c', darkColor: '#0ca30c' },
    good:  { label: 'Good time',  icon: '✓',  color: '#1baf7a', darkColor: '#199e70' },
    ok:    { label: 'OK time',    icon: '~',  color: '#c98500', darkColor: '#fab219' },
    poor:  { label: 'Poor time',  icon: '!',  color: '#ec835a', darkColor: '#ec835a' },
    awful: { label: 'Awful time', icon: '!!', color: '#d03b3b', darkColor: '#e66767' },
  },

  // Advisor tuning (see advisor.js). Percentile banding is clamped by absolute
  // anchors so uniformly-expensive or plunge days don't mislead. Anchors drift
  // with wholesale prices — revisit yearly.
  advisor: {
    percentiles: { great: 10, good: 30, ok: 60, poor: 85 }, // <= these percentile ranks
    anchors: { forceGreatAt: 0, atLeastGoodBelow: 10, atLeastPoorAbove: 35, forceAwfulAbove: 60 },
    runNowIfSavingPctBelow: 5,
    runNowIfSavingPenceBelow: 5,
    horizonCaveatIfSavingPctBelow: 15,
    horizonAbutHours: 2,
  },

  // Typical UK cycle defaults — editable in the UI. shiftable:false appliances
  // still get a verdict but the UI never nags to defer them.
  appliances: [
    { id: 'dryer',      label: 'Tumble dryer',    durationH: 2.5, energyKwh: 3.0, shiftable: true,  interruptible: false },
    { id: 'washing',    label: 'Washing machine', durationH: 2.0, energyKwh: 1.0, shiftable: true,  interruptible: false },
    { id: 'dishwasher', label: 'Dishwasher',      durationH: 3.0, energyKwh: 1.2, shiftable: true,  interruptible: false },
    { id: 'oven',       label: 'Oven',            durationH: 1.0, energyKwh: 1.2, shiftable: false, interruptible: false },
    { id: 'ev',         label: 'EV charge (7kW)', durationH: 4.0, energyKwh: 28,  shiftable: true,  interruptible: true },
    { id: 'immersion',  label: 'Immersion',       durationH: 2.0, energyKwh: 6.0, shiftable: true,  interruptible: true },
  ],

  refresh: {
    tickMs: 60_000,          // "now" marker + verdict re-evaluation
    refetchMs: 15 * 60_000,  // normal refetch cadence
    huntMs: 10 * 60_000,     // faster poll while waiting for tomorrow's publication
    huntFromUtcHour: 15,     // publication is ~16:00 UK; start hunting 15:00 UTC (16:00 BST)
  },
};
