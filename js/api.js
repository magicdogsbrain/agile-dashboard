/* Octopus API access. All product/tariff endpoints are public (no auth) and
   CORS-open (Access-Control-Allow-Origin: *), verified 2026-09-03.
   Fallback order: live API -> committed snapshot data/rates.json -> embedded
   data (window.EMBEDDED_RATES, used by the artifact preview build). */
window.AgileApi = (() => {
  const C = window.AGILE_CONFIG;

  async function getJson(url, { retries = 1 } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
        return await res.json();
      } catch (e) {
        if (e.fatal || attempt >= retries) throw e;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  }

  // API returns rates NEWEST-first; normalize to ascending {start,end,price}.
  // Agile has no payment-method split (payment_method: null) but filter
  // defensively in case the fetcher is pointed at another product.
  function normalize(results) {
    return results
      .filter((r) => !r.payment_method || r.payment_method === 'DIRECT_DEBIT')
      .map((r) => ({
        start: Date.parse(r.valid_from),
        end: Date.parse(r.valid_to),
        price: r.value_inc_vat, // inc VAT for import; export has no VAT (inc === exc)
      }))
      .sort((a, b) => a.start - b.start);
  }

  function ratesUrl(product, region, fromMs, toMs) {
    const tariff = C.api.tariffCode(product, region);
    const qs = new URLSearchParams({
      period_from: new Date(fromMs).toISOString(),
      period_to: new Date(toMs).toISOString(),
      page_size: '1500',
    });
    return `${C.api.base}/v1/products/${product}/electricity-tariffs/${tariff}/standard-unit-rates/?${qs}`;
  }

  // Live product discovery so a future AGILE relaunch doesn't kill the page.
  // Falls back silently to the configured codes.
  let discovered = null;
  async function discoverProducts() {
    if (discovered) return discovered;
    try {
      const j = await getJson(`${C.api.base}/v1/products/?page_size=250`, { retries: 0 });
      const live = (j.results || []).filter((p) => !p.available_to || Date.parse(p.available_to) > Date.now());
      const imp = live.filter((p) => p.direction === 'IMPORT' && /^AGILE-/.test(p.code) && p.brand === 'OCTOPUS_ENERGY')
        .sort((a, b) => Date.parse(b.available_from) - Date.parse(a.available_from))[0];
      const exp = live.filter((p) => p.direction === 'EXPORT' && /^AGILE-OUTGOING/.test(p.code) && p.brand === 'OCTOPUS_ENERGY')
        .sort((a, b) => Date.parse(b.available_from) - Date.parse(a.available_from))[0];
      discovered = {
        importProduct: (imp && imp.code) || C.api.importProduct,
        exportProduct: (exp && exp.code) || C.api.exportProduct,
      };
    } catch (e) {
      discovered = { importProduct: C.api.importProduct, exportProduct: C.api.exportProduct };
    }
    return discovered;
  }

  /** Fetch import + export slots covering [now-24h, now+48h].
      Returns {importSlots, exportSlots, source, generatedAt, products}. */
  async function fetchRates(region) {
    const now = Date.now();
    const from = now - 24 * 3600_000;
    const to = now + 48 * 3600_000;

    // 1. Live API
    try {
      const products = await discoverProducts();
      const [imp, exp] = await Promise.all([
        getJson(ratesUrl(products.importProduct, region, from, to)),
        getJson(ratesUrl(products.exportProduct, region, from, to)),
      ]);
      const importSlots = normalize(imp.results || []);
      // A 200 with zero rows is an outage in disguise — fall through to the
      // snapshot rather than rendering an empty dashboard forever.
      if (!importSlots.length) throw new Error('live API returned no rates');
      return {
        importSlots,
        exportSlots: normalize(exp.results || []),
        source: 'live', generatedAt: now, products, region,
      };
    } catch (liveErr) {
      // 2. Committed snapshot (GitHub Action fallback)
      try {
        const snap = await getJson(`${C.api.snapshotUrl}?v=${Math.floor(now / 300_000)}`, { retries: 0 });
        return snapshotToRates(snap, liveErr);
      } catch (snapErr) {
        // 3. Embedded data (artifact preview build)
        if (window.EMBEDDED_RATES) return snapshotToRates(window.EMBEDDED_RATES, liveErr);
        throw liveErr;
      }
    }
  }

  function snapshotToRates(snap, liveErr) {
    const toSlots = (rows) => rows
      .map((r) => ({ start: Date.parse(r.from), end: Date.parse(r.to), price: r.price }))
      .sort((a, b) => a.start - b.start);
    return {
      importSlots: toSlots(snap.import.rates),
      exportSlots: toSlots(snap.export.rates),
      source: 'snapshot', generatedAt: Date.parse(snap.generated_at) || null,
      products: { importProduct: snap.import.product, exportProduct: snap.export.product },
      region: snap.region, liveError: liveErr && String(liveErr.message || liveErr),
    };
  }

  /** Postcode -> GSP region letter (or null). Outward code alone works. */
  async function regionForPostcode(postcode) {
    const qs = new URLSearchParams({ postcode: postcode.trim() });
    const j = await getJson(`${C.api.base}/v1/industry/grid-supply-points/?${qs}`, { retries: 0 });
    if (!j.results || !j.results.length) return null;
    const letter = String(j.results[0].group_id || '').replace(/^_/, '');
    return C.regions[letter] ? letter : null;
  }

  return { fetchRates, regionForPostcode, discoverProducts, normalize };
})();
