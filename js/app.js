/* App shell: state, DOM wiring, render loop. No framework, no build step. */
(() => {
  const C = window.AGILE_CONFIG;
  const T = window.AgileTime;
  const A = window.AgileAdvisor;
  const $ = (id) => document.getElementById(id);

  // ---------- settings (localStorage can throw in private browsing) ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(`agileboard.${key}`); return v === null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`agileboard.${key}`, JSON.stringify(value)); } catch { /* per-viewer nicety only */ }
    },
  };

  const state = {
    region: store.get('region', C.defaultRegion),
    applianceId: store.get('appliance', 'dryer'),
    custom: store.get('custom', null), // {durationH, energyKwh}
    theme: store.get('theme', 'system'),
    data: null,      // {importSlots, exportSlots, source, generatedAt, products, region}
    evaluation: null,
    timers: { tick: null, refetch: null },
    fetchSeq: 0, // latest-wins: stale in-flight responses are discarded
  };

  function appliance() {
    const base = C.appliances.find((a) => a.id === state.applianceId) || C.appliances[0];
    if (state.applianceId === 'custom' && state.custom) {
      return { id: 'custom', label: 'Custom', shiftable: true, interruptible: false, ...state.custom };
    }
    return base;
  }

  // ---------- theme ----------
  function applyTheme() {
    if (state.theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', state.theme);
    $('theme-toggle').textContent = { system: '◐ auto', light: '○ light', dark: '● dark' }[state.theme];
    window.AgileCharts.retheme();
    renderRibbon();
    renderBandLegend();
    renderTable();
    renderHero();
  }

  // ---------- rendering ----------
  const fmtPrice = (p, dp = 1) => (p === null || p === undefined || Number.isNaN(p)) ? '—' : `${p.toFixed(dp)}p`;

  function bandColorFor(price) {
    const b = A.bandOf(price, C.bands);
    return window.AgileCharts.isDark() ? b.dark : b.light;
  }

  function renderHero() {
    const ev = state.evaluation;
    const app = appliance();
    const chip = $('verdict-chip');
    if (!ev || ev.state !== 'ok') {
      chip.hidden = true;
      // Before the first fetch resolves there is no evaluation yet — keep the
      // "Loading prices…" text rather than flashing "no data".
      if (!ev && !state.data) return;
      $('now-price').textContent = '—';
      $('now-band').textContent = '';
      $('recommendation').textContent = ev && ev.message ? ev.message : 'No price data available.';
      $('caveat').hidden = true;
      document.title = 'Agile Board';
      return;
    }
    const v = C.verdicts[ev.verdict];
    chip.hidden = false;
    chip.style.setProperty('--verdict-color', window.AgileCharts.isDark() ? v.darkColor : v.color);
    $('verdict-icon').textContent = v.icon;
    $('verdict-label').textContent = app.shiftable ? `${v.label} to run it` : v.label;
    $('now-price').textContent = fmtPrice(ev.currentPrice);
    $('now-band').textContent = `${ev.band.label} · until ${T.hm(ev.currentSlot.end)}`;
    $('recommendation').textContent = ev.recommendation || ev.message || '';
    const caveat = $('caveat');
    caveat.hidden = !ev.caveat;
    caveat.textContent = ev.caveat || '';
    document.title = `${fmtPrice(ev.currentPrice)} · Agile Board`;
  }

  function renderAppliances(refocus) {
    const row = $('appliance-row');
    row.textContent = '';
    const items = [...C.appliances, { id: 'custom', label: 'Custom…' }];
    for (const a of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.id = a.id;
      btn.className = 'chip' + (state.applianceId === a.id ? ' selected' : '');
      btn.setAttribute('aria-pressed', String(state.applianceId === a.id));
      btn.textContent = a.label;
      btn.addEventListener('click', () => {
        state.applianceId = a.id;
        store.set('appliance', a.id);
        evaluateAndRender();
        renderAppliances(true); // rebuild removes the activated button — restore focus
      });
      row.appendChild(btn);
    }
    if (refocus) {
      const sel = row.querySelector(`[data-id="${state.applianceId}"]`);
      if (sel) sel.focus();
    }
    // The fields stay visible for presets too — they show the assumptions, and
    // editing them deliberately switches to Custom.
    const app = appliance();
    $('duration-input').value = app.durationH;
    $('energy-input').value = app.energyKwh;
  }

  function renderRibbon() {
    const el = $('ribbon');
    el.textContent = '';
    if (!state.data) return;
    const now = Date.now();
    const slots = state.data.importSlots.filter((s) => s.end > now);
    if (!slots.length) { $('ribbon-labels').textContent = ''; return; }
    const best = state.evaluation && state.evaluation.best;
    let bestFirst = -1, bestCount = 0;
    slots.forEach((s, i) => {
      const cell = document.createElement('div');
      cell.className = 'ribbon-cell';
      if (best && s.start >= best.start && s.end <= best.end) {
        if (bestFirst < 0) bestFirst = i;
        bestCount++;
      }
      if (now >= s.start && now < s.end) cell.classList.add('current');
      cell.style.background = bandColorFor(s.price);
      cell.title = `${T.hm(s.start)}–${T.hm(s.end)} · ${s.price.toFixed(2)}p/kWh`;
      el.appendChild(cell);
    });
    if (bestFirst >= 0) {
      const bracket = document.createElement('div');
      bracket.className = 'ribbon-bracket';
      bracket.style.left = `${(bestFirst / slots.length) * 100}%`;
      bracket.style.width = `${(bestCount / slots.length) * 100}%`;
      el.appendChild(bracket);
    }
    const labels = $('ribbon-labels');
    labels.textContent = '';
    const mk = (txt, cls) => {
      const span = document.createElement('span');
      span.textContent = txt; if (cls) span.className = cls;
      labels.appendChild(span);
    };
    mk('now');
    if (best) mk(`▾ best: ${T.friendly(best.start, now)}`, 'ribbon-best-label');
    mk(T.friendly(slots[slots.length - 1].end, now), 'ribbon-end');
  }

  function dayStats(slots) {
    const now = Date.now();
    const todayKey = T.londonDateKey(now);
    const today = slots.filter((s) => T.londonDateKey(s.start) === todayKey);
    if (!today.length) return null;
    const prices = today.map((s) => s.price);
    return {
      avg: prices.reduce((a, b) => a + b, 0) / prices.length,
      min: Math.min(...prices),
      max: Math.max(...prices),
    };
  }

  function renderTiles() {
    const d = state.data;
    const ev = state.evaluation;
    const now = Date.now();
    const impNow = d && d.importSlots.find((s) => now >= s.start && now < s.end);
    const expNow = d && d.exportSlots.find((s) => now >= s.start && now < s.end);
    const impStats = d ? dayStats(d.importSlots) : null;
    const expStats = d ? dayStats(d.exportSlots) : null;

    $('tile-import-value').textContent = impNow ? fmtPrice(impNow.price) : '—';
    $('tile-import-sub').textContent = impStats
      ? `today ${fmtPrice(impStats.min)} – ${fmtPrice(impStats.max)}, avg ${fmtPrice(impStats.avg)}` : 'no data for today';
    $('tile-export-value').textContent = expNow ? fmtPrice(expNow.price) : '—';
    $('tile-export-sub').textContent = expStats
      ? `today avg ${fmtPrice(expStats.avg)} · you're paid this to export` : 'no data for today';

    if (ev && ev.state === 'ok' && ev.best) {
      $('tile-best-value').textContent = T.friendly(ev.best.start, now);
      $('tile-best-sub').textContent = `${appliance().durationH}h window · avg ${fmtPrice(ev.best.meanPrice)}/kWh`;
    } else {
      $('tile-best-value').textContent = '—';
      $('tile-best-sub').textContent = 'window doesn’t fit in known prices';
    }

    const horizon = d && d.importSlots.length ? d.importSlots[d.importSlots.length - 1].end : null;
    $('tile-horizon-value').textContent = horizon ? T.friendly(horizon, now) : '—';
    $('tile-horizon-sub').textContent = horizon && !T.coversTomorrow(horizon, now)
      ? 'tomorrow’s prices land ~4pm' : 'tomorrow is in';
  }

  function renderBandLegend() {
    const el = $('band-legend');
    el.textContent = '';
    let prev = null;
    for (const b of C.bands) {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const key = document.createElement('span');
      key.className = 'legend-key';
      key.style.background = window.AgileCharts.isDark() ? b.dark : b.light;
      const range = b.max === Infinity ? `>${prev}p` : (prev === null ? `≤${b.max}p` : `${prev}–${b.max}p`);
      item.appendChild(key);
      item.appendChild(document.createTextNode(`${b.label} ${range}`));
      el.appendChild(item);
      prev = b.max === Infinity ? prev : b.max;
    }
  }

  function renderTable() {
    const tbody = $('slot-table-body');
    tbody.textContent = '';
    if (!state.data) return;
    const now = Date.now();
    const exportByStart = new Map(state.data.exportSlots.map((s) => [s.start, s]));
    for (const s of state.data.importSlots) {
      const tr = document.createElement('tr');
      if (s.end <= now) tr.className = 'past';
      if (now >= s.start && now < s.end) tr.className = 'current';
      const exp = exportByStart.get(s.start);
      const band = A.bandOf(s.price, C.bands);
      const cells = [
        `${T.dayLabel(s.start)} ${T.hm(s.start)}–${T.hm(s.end)}`,
        s.price.toFixed(2),
        exp ? exp.price.toFixed(2) : '—',
        band.label,
      ];
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        if (i === 3) {
          const key = document.createElement('span');
          key.className = 'legend-key';
          key.style.background = bandColorFor(s.price);
          td.appendChild(key);
        }
        td.appendChild(document.createTextNode(c));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  }

  function renderBanner() {
    const el = $('status-banner');
    const d = state.data;
    if (!d) { el.hidden = true; return; }
    if (d.source === 'snapshot') {
      el.hidden = false;
      const mismatch = d.region && d.region !== state.region
        ? ` NOTE: the snapshot covers region ${d.region} (${C.regions[d.region] || ''}) — not your selected region ${state.region}, whose prices will differ.`
        : '';
      el.textContent = `Live Octopus API unreachable — showing the committed snapshot` +
        (d.generatedAt ? ` from ${T.full(d.generatedAt)}` : '') + `. Retrying automatically.` + mismatch;
    } else {
      el.hidden = true;
    }
  }

  function renderMeta() {
    const d = state.data;
    if (!d) return;
    // Label the data with the region it actually covers (a snapshot may not
    // match the selected region), never just the selection.
    const shown = d.region || state.region;
    const bits = [
      `Region ${shown} — ${C.regions[shown] || ''}`,
      `${d.products.importProduct} / ${d.products.exportProduct}`,
      d.source === 'live' ? `live · fetched ${T.hm(d.generatedAt)}` : 'snapshot',
      'prices are p/kWh inc VAT (export has no VAT)',
    ];
    $('meta-line').textContent = bits.join(' · ');
  }

  function evaluateAndRender() {
    if (state.data) {
      state.evaluation = A.evaluate(state.data.importSlots, Date.now(), appliance(), C);
    }
    renderHero();
    renderTiles();
    renderRibbon();
    if (state.data) {
      window.AgileCharts.render(
        state.data.importSlots, state.data.exportSlots, Date.now(),
        state.evaluation && state.evaluation.best,
      );
    }
    renderTable();
  }

  // ---------- data ----------
  async function fetchAndRender() {
    const seq = ++state.fetchSeq;
    $('refresh-btn').classList.add('busy');
    try {
      const data = await window.AgileApi.fetchRates(state.region);
      if (seq !== state.fetchSeq) return; // superseded (e.g. region changed mid-flight)
      state.data = data;
      $('empty-state').hidden = true;
      $('dashboard').hidden = false;
      evaluateAndRender();
      renderBanner();
      renderMeta();
    } catch (e) {
      if (seq !== state.fetchSeq) return;
      if (!state.data) {
        $('dashboard').hidden = true;
        const empty = $('empty-state');
        empty.hidden = false;
        $('empty-detail').textContent = `Could not reach api.octopus.energy (${e && e.message ? e.message : e}). ` +
          `Check your connection — the dashboard retries automatically.`;
      }
    } finally {
      if (seq === state.fetchSeq) {
        $('refresh-btn').classList.remove('busy');
        scheduleRefetch();
      }
    }
  }

  function scheduleRefetch() {
    clearTimeout(state.timers.refetch);
    // Hunt faster while tomorrow's prices are pending and it's past ~4pm UK.
    const horizon = state.data && state.data.importSlots.length
      ? state.data.importSlots[state.data.importSlots.length - 1].end : null;
    const pending = horizon && !T.coversTomorrow(horizon, Date.now());
    const hunting = pending && new Date().getUTCHours() >= C.refresh.huntFromUtcHour;
    const delay = state.data ? (hunting ? C.refresh.huntMs : C.refresh.refetchMs) : C.refresh.huntMs;
    state.timers.refetch = setTimeout(fetchAndRender, delay);
  }

  let lastTableSlotStart = null;
  function minuteTick() {
    if (!state.data) return;
    const now = Date.now();
    state.evaluation = A.evaluate(state.data.importSlots, now, appliance(), C);
    renderHero();
    renderTiles();
    renderRibbon();
    window.AgileCharts.tick(now, state.evaluation && state.evaluation.best);
    // Keep the table's past/current highlighting live across slot boundaries.
    const cur = state.data.importSlots.find((s) => now >= s.start && now < s.end);
    const curStart = cur ? cur.start : null;
    if (curStart !== lastTableSlotStart) {
      lastTableSlotStart = curStart;
      renderTable();
    }
  }

  // ---------- wiring ----------
  function wire() {
    const sel = $('region-select');
    for (const [letter, name] of Object.entries(C.regions)) {
      const opt = document.createElement('option');
      opt.value = letter;
      opt.textContent = `${letter} — ${name}`;
      sel.appendChild(opt);
    }
    sel.value = state.region;
    sel.addEventListener('change', () => {
      state.region = sel.value;
      store.set('region', state.region);
      state.data = null;
      fetchAndRender();
    });

    $('postcode-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('postcode-input');
      const pc = input.value.trim();
      if (!pc) return;
      input.disabled = true;
      // A disabled input is barred from constraint validation, so always
      // re-enable BEFORE reportValidity or the error bubble never shows.
      const complain = (msg) => {
        input.disabled = false;
        input.setCustomValidity(msg);
        input.reportValidity();
        setTimeout(() => input.setCustomValidity(''), 2500);
      };
      try {
        const letter = await window.AgileApi.regionForPostcode(pc);
        if (letter) {
          input.disabled = false;
          sel.value = letter;
          sel.dispatchEvent(new Event('change'));
          input.placeholder = `${pc.toUpperCase()} → region ${letter}`;
          input.value = '';
        } else {
          complain('Postcode not recognised');
        }
      } catch {
        complain('Lookup failed — pick a region manually');
      } finally {
        input.disabled = false;
      }
    });

    $('theme-toggle').addEventListener('click', () => {
      state.theme = { system: 'light', light: 'dark', dark: 'system' }[state.theme];
      store.set('theme', state.theme);
      applyTheme();
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.theme === 'system') applyTheme();
    });

    $('refresh-btn').addEventListener('click', fetchAndRender);

    const onCustomChange = () => {
      const durationH = Math.min(12, Math.max(0.5, parseFloat($('duration-input').value) || 1));
      const energyKwh = Math.min(100, Math.max(0.1, parseFloat($('energy-input').value) || 1));
      state.custom = { durationH, energyKwh };
      state.applianceId = 'custom';
      store.set('custom', state.custom);
      store.set('appliance', 'custom');
      evaluateAndRender();
      renderAppliances();
    };
    $('duration-input').addEventListener('change', onCustomChange);
    $('energy-input').addEventListener('change', onCustomChange);
  }

  // ---------- boot ----------
  document.addEventListener('DOMContentLoaded', () => {
    wire();
    renderAppliances();
    renderBandLegend();
    window.AgileCharts.init($('import-chart'), $('export-chart'));
    applyTheme();
    fetchAndRender();
    state.timers.tick = setInterval(minuteTick, C.refresh.tickMs);
  });
})();
