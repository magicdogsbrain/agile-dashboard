/* Appliance advisor — pure functions, no DOM.
   Slots are {start, end, price} in ascending order, price = p/kWh inc VAT.

   Phase 2 seam: everything below ranks slots by costModel.effectivePrice(slot).
   The phase-1 model is just the import rate. When solar + battery + FoxESS land,
   swap in a model that returns the marginal cost per kWh (export rate when PV
   surplus would be displaced, stored-energy value when the battery covers the
   load, import rate otherwise) — banding, argmin and wording all follow along. */
window.AgileAdvisor = (() => {
  const importOnlyCostModel = { effectivePrice: (slot) => slot.price };

  function bandOf(price, bands) {
    for (const b of bands) if (price <= b.max) return b;
    return bands[bands.length - 1];
  }

  // Percentile rank (0-100) of price among the known prices in the next 24h.
  // Mid-rank tie handling (excluding this slot's own occurrence) so a flat day
  // ranks ~50 instead of every slot claiming rank 0.
  function percentileRank(price, prices) {
    if (!prices.length) return 50;
    const below = prices.filter((p) => p < price).length;
    const equalOthers = Math.max(0, prices.filter((p) => p === price).length - 1);
    return ((below + 0.5 * equalOthers) / prices.length) * 100;
  }

  function verdictFor(price, next24hPrices, cfg) {
    const order = ['great', 'good', 'ok', 'poor', 'awful'];
    const rank = percentileRank(price, next24hPrices);
    let v;
    if (rank <= cfg.percentiles.great) v = 'great';
    else if (rank <= cfg.percentiles.good) v = 'good';
    else if (rank <= cfg.percentiles.ok) v = 'ok';
    else if (rank <= cfg.percentiles.poor) v = 'poor';
    else v = 'awful';
    // Absolute anchors clamp the percentile call so a uniformly-expensive day
    // can't call 40p "great" and a plunge day can't call 5p "awful".
    const a = cfg.anchors;
    const clampAtLeast = (want) => order[Math.min(order.indexOf(v), order.indexOf(want))];
    const clampAtWorst = (want) => order[Math.max(order.indexOf(v), order.indexOf(want))];
    if (price > a.forceAwfulAbove) v = 'awful';
    else if (price > a.atLeastPoorAbove) v = clampAtWorst('poor');
    if (price < a.atLeastGoodBelow) v = clampAtLeast('good');
    if (price <= a.forceGreatAt) v = 'great';
    return { verdict: v, rank };
  }

  const mean = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
  const fmtP = (p) => `${Math.round(p)}p`;

  /**
   * Evaluate "should I run this now?".
   * @param slots ascending [{start,end,price}], both past and future ok
   * @param nowMs current time
   * @param appliance {durationH, energyKwh, shiftable, interruptible}
   * @param config AGILE_CONFIG (bands + advisor sections used)
   * @param costModel optional phase-2 cost model
   */
  function evaluate(slots, nowMs, appliance, config, costModel) {
    const cm = costModel || importOnlyCostModel;
    const cfg = config.advisor;
    const future = slots.filter((s) => s.end > nowMs);
    if (!future.length) return { state: 'no-data' };

    const eff = future.map((s) => cm.effectivePrice(s));
    const horizonEnd = future[future.length - 1].end;
    const n = Math.max(1, Math.ceil(appliance.durationH * 2 - 1e-9));

    const currentSlot = future[0];
    const currentPrice = eff[0];
    const next24h = future.filter((s) => s.start < nowMs + 24 * 3600_000).map((s) => cm.effectivePrice(s));
    const { verdict, rank } = verdictFor(currentPrice, next24h, cfg);

    // Cost of starting at this instant, time-weighted: the current slot only
    // counts for its remaining fraction, and the run spills into a partial
    // extra slot at the end (a run started mid-slot isn't slot-aligned).
    let unitsLeft = appliance.durationH * 2; // in half-hour units
    let weighted = 0, weightSum = 0, nowTruncated = false;
    for (let i = 0; i < future.length && unitsLeft > 1e-9; i++) {
      const slotUnits = (future[i].end - future[i].start) / 1800_000;
      const avail = i === 0
        ? Math.max(0, (future[0].end - nowMs) / 1800_000)
        : slotUnits;
      const w = Math.min(avail, unitsLeft);
      weighted += w * eff[i];
      weightSum += w;
      unitsLeft -= w;
    }
    if (unitsLeft > 1e-9) nowTruncated = true;
    const costNowPerKwh = weightSum > 0 ? weighted / weightSum : eff[0];
    const cycleCostNow = (costNowPerKwh * appliance.energyKwh); // pence

    // Cheapest full window via prefix sums; ties -> earliest.
    const prefix = [0];
    for (const p of eff) prefix.push(prefix[prefix.length - 1] + p);
    let best = null;
    for (let i = 0; i + n <= eff.length; i++) {
      const m = (prefix[i + n] - prefix[i]) / n;
      if (!best || m < best.meanPrice - 1e-9) {
        best = { index: i, meanPrice: m, start: future[i].start, end: future[i + n - 1].end };
      }
    }

    // Cheapest set of non-contiguous slots, for interruptible loads.
    let flexible = null;
    if (appliance.interruptible && eff.length >= n) {
      const ranked = future.map((s, i) => ({ s, p: eff[i] })).sort((a, b) => a.p - b.p).slice(0, n);
      flexible = { meanPrice: mean(ranked.map((r) => r.p)), slots: ranked.map((r) => r.s).sort((a, b) => a.start - b.start) };
    }

    const out = {
      state: 'ok', verdict, rank, currentSlot, currentPrice,
      band: bandOf(currentPrice, config.bands),
      cycleCostNow, costNowPerKwh, nowTruncated,
      best, flexible, horizonEnd, n,
      horizonLimited: !window.AgileTime.coversTomorrow(horizonEnd, nowMs),
    };

    if (!best) {
      out.message = appliance.shiftable
        ? `Not enough published prices left tonight to compare a full ${appliance.durationH}h run. Tomorrow's prices land around 4pm.`
        : `Prices are only published until ${window.AgileTime.friendly(horizonEnd, nowMs)}.`;
      return out;
    }

    const T = window.AgileTime;
    const kwh = appliance.energyKwh;

    // Non-shiftable loads (the oven) never get told to wait until 3am —
    // just price the cycle honestly and stop.
    if (!appliance.shiftable) {
      out.recommendation = cycleCostNow < 0
        ? `Running it now would actually pay you about ${fmtP(-cycleCostNow)} for a ${kwh}kWh cycle.`
        : `A ${kwh}kWh cycle right now costs about ${fmtP(cycleCostNow)}. Not something worth delaying — this is just the price.`;
      return out;
    }

    // Pick the plan to recommend: the contiguous window, or — for
    // interruptible loads — the cheaper set of non-contiguous slots.
    let plan = { meanPrice: best.meanPrice, start: best.start, split: false };
    if (flexible && flexible.meanPrice < best.meanPrice - 0.05) {
      plan = { meanPrice: flexible.meanPrice, start: flexible.slots[0].start, split: true };
    }
    const cycleCostBest = plan.meanPrice * kwh;
    const savingPence = cycleCostNow - cycleCostBest;
    const savingPct = cycleCostNow > 0.1 ? (savingPence / cycleCostNow) * 100 : null;
    out.cycleCostBest = cycleCostBest;
    out.savingPence = savingPence;
    out.savingPct = savingPct;
    out.bestIsNow = best.index === 0 && !plan.split;
    out.plan = plan;

    const paidNow = cycleCostNow < 0;

    if (out.bestIsNow || savingPence < cfg.runNowIfSavingPenceBelow ||
        (savingPct !== null && savingPct < cfg.runNowIfSavingPctBelow)) {
      out.recommendation = paidNow
        ? `Run it now — you'd be paid about ${fmtP(-cycleCostNow)} for a ${kwh}kWh cycle.`
        : `Run it now — waiting saves ${savingPence <= 0 ? 'nothing' : `only ~${fmtP(savingPence)}`}. Now costs about ${fmtP(cycleCostNow)} for a ${kwh}kWh cycle.`;
    } else {
      const when = T.friendly(plan.start, nowMs);
      const paidBest = cycleCostBest < 0;
      const savings = savingPct !== null
        ? `saves ${Math.round(savingPct)}% (~${fmtP(savingPence)})`
        : `saves ~${fmtP(savingPence)}`;
      const target = plan.split
        ? `Spread it over the ${n} cheapest half-hours (first at ${when})`
        : `Wait until ${when}`;
      out.recommendation = paidBest
        ? `${target} — you'd be PAID about ${fmtP(-cycleCostBest)} for a ${kwh}kWh cycle.`
        : `${target} — ${savings} on a ${kwh}kWh cycle (${fmtP(cycleCostBest)} vs ${fmtP(cycleCostNow)} now).`;
    }

    // Pre-publication caveat: the true optimum may lie beyond the known horizon.
    const abutsHorizon = best.end > horizonEnd - cfg.horizonAbutHours * 3600_000;
    if (out.horizonLimited &&
        (abutsHorizon || savingPct === null || savingPct < cfg.horizonCaveatIfSavingPctBelow)) {
      out.caveat = `Tomorrow's prices arrive around 4pm — overnight is often cheaper than anything published yet.`;
    }
    return out;
  }

  return { evaluate, bandOf, verdictFor, percentileRank, importOnlyCostModel };
})();
