/* Account page: connect with an Octopus API key (browser-only, localStorage),
   discover the account's real tariff/region/meters, and price actual
   half-hourly consumption on Agile AND on the account's current tariff.
   Works whether or not the account is on Agile yet — pre-switch it's a
   "what would Agile have cost" preview; post-switch it's actual costs. */
(() => {
  const C = window.AGILE_CONFIG;
  const T = window.AgileTime;
  const $ = (id) => document.getElementById(id);
  const DAYS = 30;

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(`agileboard.${key}`); return v === null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`agileboard.${key}`, JSON.stringify(value)); } catch { /* best effort */ }
    },
    del(key) { try { localStorage.removeItem(`agileboard.${key}`); } catch { /* ignore */ } },
  };

  const state = {
    key: store.get('apikey', ''),
    account: store.get('account', ''),
    theme: store.get('theme', 'system'),
    charts: [],
  };

  // ---------- authenticated API ----------
  function authedGet(path) {
    const url = path.startsWith('http') ? path : `${C.api.base}${path}`;
    return fetch(url, {
      cache: 'no-cache',
      headers: { Authorization: 'Basic ' + btoa(`${state.key}:`) },
    }).then((res) => {
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error('auth'), { auth: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });
  }

  async function getAllPages(path, cap = 10) {
    let url = path, out = [];
    for (let i = 0; i < cap && url; i++) {
      const page = await authedGet(url);
      out = out.concat(page.results || []);
      url = page.next;
    }
    return out;
  }

  // ---------- account parsing (pure) ----------
  function activeAgreement(agreements, nowIso) {
    const now = nowIso || new Date().toISOString();
    return (agreements || []).find((a) =>
      a.valid_from <= now && (!a.valid_to || a.valid_to > now)) || null;
  }

  // E-1R-VAR-22-11-01-C -> { product: 'VAR-22-11-01', region: 'C' }
  function parseTariffCode(code) {
    const parts = String(code || '').split('-');
    if (parts.length < 4) return null;
    return { product: parts.slice(2, -1).join('-'), region: parts[parts.length - 1] };
  }

  function summariseAccount(acct) {
    const points = [];
    for (const prop of acct.properties || []) {
      for (const mp of prop.electricity_meter_points || []) {
        const agreement = activeAgreement(mp.agreements);
        points.push({
          mpan: mp.mpan,
          isExport: !!mp.is_export,
          serials: (mp.meters || []).map((m) => m.serial_number).filter(Boolean),
          tariffCode: agreement && agreement.tariff_code,
          parsed: agreement ? parseTariffCode(agreement.tariff_code) : null,
        });
      }
    }
    return {
      importPoint: points.find((p) => !p.isExport) || null,
      exportPoint: points.find((p) => p.isExport) || null,
      points,
    };
  }

  // ---------- rates + joining (pure) ----------
  // Generic: works for Agile (30-min rows) and flat/fixed tariffs (long rows).
  function buildRateLookup(rows) {
    const rates = rows
      .filter((r) => !r.payment_method || r.payment_method === 'DIRECT_DEBIT')
      .map((r) => ({ from: Date.parse(r.valid_from), to: r.valid_to ? Date.parse(r.valid_to) : Infinity, price: r.value_inc_vat }))
      .sort((a, b) => a.from - b.from);
    return (ms) => {
      // rates lists are small (<=1500); linear scan from a moving cursor
      for (const r of rates) if (ms >= r.from && ms < r.to) return r.price;
      return null;
    };
  }

  function priceConsumption(consRows, rateAt) {
    let kwh = 0, cost = 0, matched = 0;
    const daily = new Map();   // londonDateKey -> {kwh, cost}
    const profile = new Map(); // 'HH:MM' London -> {kwh, days:Set, price, priceN}
    for (const row of consRows) {
      const ms = Date.parse(row.interval_start);
      const p = rateAt(ms);
      if (p === null || p === undefined) continue;
      matched++;
      const rowCost = row.consumption * p;
      kwh += row.consumption; cost += rowCost;
      const day = T.londonDateKey(ms);
      const d = daily.get(day) || { kwh: 0, cost: 0, slots: 0 };
      d.kwh += row.consumption; d.cost += rowCost; d.slots++;
      daily.set(day, d);
      const hm = T.hm(ms);
      const s = profile.get(hm) || { kwh: 0, n: 0, price: 0 };
      s.kwh += row.consumption; s.n++; s.price += p;
      profile.set(hm, s);
    }
    return { kwh, cost, matched, daily, profile };
  }

  // ---------- rendering ----------
  const fmtGBP = (pence) => {
    const neg = pence < 0;
    const abs = Math.abs(pence);
    return (neg ? '−' : '') + (abs >= 100 ? `£${(abs / 100).toFixed(2)}` : `${Math.round(abs)}p`);
  };

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const isDark = () => {
    const forced = document.documentElement.getAttribute('data-theme');
    if (forced) return forced === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  };
  const bandColor = (price) => {
    const b = window.AgileAdvisor.bandOf(price, C.bands);
    return isDark() ? b.dark : b.light;
  };

  function setStatus(msg, isError) {
    const el = $('connect-status');
    el.hidden = !msg;
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }

  function kv(dl, label, value) {
    const div = document.createElement('div');
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = value;
    div.append(dt, dd); dl.appendChild(div);
  }

  function friendlyTariffName(parsed, tariffCode) {
    if (!parsed) return tariffCode || 'unknown';
    if (parsed.product.startsWith('AGILE')) return `Agile (${tariffCode})`;
    if (parsed.product.startsWith('VAR')) return `Flexible Octopus (${tariffCode})`;
    return tariffCode;
  }

  function baseChartOption() {
    return {
      animation: false,
      backgroundColor: 'transparent',
      grid: { left: 48, right: 14, top: 18, bottom: 40 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: cssVar('--surface-1'),
        borderColor: cssVar('--hairline'),
        textStyle: { color: cssVar('--text-primary'), fontSize: 12 },
      },
      xAxis: {
        type: 'category',
        axisLine: { lineStyle: { color: cssVar('--baseline') } },
        axisTick: { show: false },
        axisLabel: { color: cssVar('--text-muted'), fontSize: 11, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: cssVar('--text-muted'), fontSize: 11 },
        splitLine: { lineStyle: { color: cssVar('--gridline'), width: 1 } },
        splitNumber: 4,
      },
    };
  }

  function disposeCharts() {
    for (const c of state.charts) c.dispose();
    state.charts = [];
  }

  function renderCharts(result) {
    disposeCharts();
    if (typeof window.echarts === 'undefined') return;

    // Daily Agile cost, single series in slot-1 blue.
    const days = [...result.agile.daily.keys()].sort();
    const daily = window.echarts.init($('daily-chart'), null, { renderer: 'canvas' });
    const opt = baseChartOption();
    opt.xAxis.data = days.map((d) => d.slice(5));
    opt.yAxis.axisLabel.formatter = (v) => `£${v}`;
    opt.tooltip.formatter = (params) => {
      const i = params[0].dataIndex;
      const d = result.agile.daily.get(days[i]);
      const own = result.own && result.own.daily.get(days[i]);
      return `<b>${days[i]}</b><br>${d.kwh.toFixed(1)} kWh · Agile ${fmtGBP(d.cost)}` +
        (own ? `<br>${result.ownLabel}: ${fmtGBP(own.cost)}` : '');
    };
    opt.series = [{
      type: 'bar', name: 'Agile cost',
      data: days.map((d) => +(result.agile.daily.get(d).cost / 100).toFixed(2)),
      itemStyle: { color: cssVar('--accent'), borderRadius: [3, 3, 0, 0] },
      barMaxWidth: 24,
    }];
    daily.setOption(opt);
    state.charts.push(daily);

    // Usage-by-time-of-day, bars coloured by average Agile price band then.
    const slots = [...result.agile.profile.keys()].sort();
    const prof = window.echarts.init($('profile-chart'), null, { renderer: 'canvas' });
    const p2 = baseChartOption();
    p2.xAxis.data = slots;
    p2.xAxis.axisLabel.interval = 7; // every 4 hours
    p2.yAxis.axisLabel.formatter = (v) => `${v} kWh`;
    p2.tooltip.formatter = (params) => {
      const i = params[0].dataIndex;
      const s = result.agile.profile.get(slots[i]);
      return `<b>${slots[i]}</b><br>avg ${(s.kwh / Math.max(1, s.n)).toFixed(2)} kWh · avg price ${(s.price / Math.max(1, s.n)).toFixed(1)}p`;
    };
    p2.series = [{
      type: 'bar', name: 'Average usage',
      data: slots.map((hm) => {
        const s = result.agile.profile.get(hm);
        return {
          value: +(s.kwh / Math.max(1, s.n)).toFixed(3),
          itemStyle: { color: bandColor(s.price / Math.max(1, s.n)), borderRadius: [2, 2, 0, 0] },
        };
      }),
      barCategoryGap: '20%',
    }];
    prof.setOption(p2);
    state.charts.push(prof);

    const legend = $('profile-legend');
    legend.textContent = '';
    let prev = null;
    for (const b of C.bands) {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const key = document.createElement('span');
      key.className = 'legend-key';
      key.style.background = isDark() ? b.dark : b.light;
      const range = b.max === Infinity ? `>${prev}p` : (prev === null ? `≤${b.max}p` : `${prev}–${b.max}p`);
      item.append(key, document.createTextNode(`${b.label} ${range}`));
      legend.appendChild(item);
      prev = b.max === Infinity ? prev : b.max;
    }
  }

  function renderTable(result) {
    const tbody = $('daily-table-body');
    tbody.textContent = '';
    $('own-cost-col').textContent = result.ownLabel || 'Your tariff';
    const days = [...result.agile.daily.keys()].sort().reverse();
    for (const day of days) {
      const a = result.agile.daily.get(day);
      const o = result.own && result.own.daily.get(day);
      const tr = document.createElement('tr');
      for (const cell of [day, a.kwh.toFixed(1), fmtGBP(a.cost), o ? fmtGBP(o.cost) : '—']) {
        const td = document.createElement('td');
        td.textContent = cell;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  function renderResults(summary, result) {
    const dl = $('account-summary');
    dl.textContent = '';
    const imp = summary.importPoint;
    kv(dl, 'Import tariff', friendlyTariffName(imp && imp.parsed, imp && imp.tariffCode));
    kv(dl, 'Region', imp && imp.parsed ? `${imp.parsed.region} — ${C.regions[imp.parsed.region] || ''}` : 'unknown');
    kv(dl, 'Import MPAN', imp ? imp.mpan : '—');
    kv(dl, 'Export meter', summary.exportPoint
      ? friendlyTariffName(summary.exportPoint.parsed, summary.exportPoint.tariffCode)
      : 'none yet — appears after solar registration');
    kv(dl, 'On Agile already?', result.onAgile ? 'yes — costs below are your actual Agile costs' : 'not yet — Agile figures below are a preview');

    // Tiles
    const yday = result.latestDay;
    if (yday) {
      const d = result.agile.daily.get(yday);
      $('tile-yday-label').textContent = result.onAgile ? `${yday} on Agile` : `${yday} — would have been`;
      $('tile-yday-value').textContent = fmtGBP(d.cost);
      $('tile-yday-sub').textContent = `${d.kwh.toFixed(1)} kWh · avg ${(d.cost / Math.max(0.01, d.kwh)).toFixed(1)}p/kWh`;
    }
    const avgRate = result.agile.cost / Math.max(0.01, result.agile.kwh);
    $('tile-rate-value').textContent = `${avgRate.toFixed(1)}p`;
    $('tile-rate-sub').textContent = `${result.agile.kwh.toFixed(0)} kWh over ${result.dayCount} days, your real usage pattern`;

    if (result.own) {
      const diff = result.own.cost - result.agile.cost;
      $('tile-vs-label').textContent = result.onAgile ? '30 days: Agile vs Flexible-style' : `30 days: Agile vs ${result.ownLabel}`;
      $('tile-vs-value').textContent = `${fmtGBP(result.agile.cost)} vs ${fmtGBP(result.own.cost)}`;
      $('tile-vs-sub').textContent = diff >= 0
        ? `Agile ${fmtGBP(diff)} cheaper on your usage`
        : `Agile ${fmtGBP(-diff)} MORE expensive this window`;
      const annual = diff / result.dayCount * 365 + (result.standingDeltaPencePerDay || 0) * 365;
      $('tile-year-value').textContent = `${fmtGBP(Math.abs(annual))} ${annual >= 0 ? 'less' : 'more'}`;
      $('tile-year-sub').textContent = `on Agile · unit rates${result.standingDeltaPencePerDay ? ' + standing charge' : ''}, scaled from these ${result.dayCount} days`;
    } else {
      $('tile-vs-value').textContent = '—';
      $('tile-vs-sub').textContent = 'could not fetch your tariff’s rates';
      $('tile-year-value').textContent = '—';
    }

    $('daily-basis').textContent = result.onAgile ? '' : ' — a preview; you’re not on Agile yet';
    renderCharts(result);
    renderTable(result);
    $('meta-line').textContent = [
      `account ${state.account}`,
      `window ${result.firstDay} → ${result.latestDay}`,
      `${result.agile.matched} half-hours priced`,
      'key stored only in this browser',
    ].join(' · ');
  }

  // ---------- the main flow ----------
  async function connectAndLoad() {
    setStatus('Connecting…');
    $('connect-btn').disabled = true;
    try {
      const acct = await authedGet(`/v1/accounts/${encodeURIComponent(state.account)}/`);
      const summary = summariseAccount(acct);
      if (!summary.importPoint) throw new Error('no electricity meter point on this account');
      const imp = summary.importPoint;
      const region = (imp.parsed && C.regions[imp.parsed.region]) ? imp.parsed.region : C.defaultRegion;
      store.set('region', region); // main dashboard follows the account's real region

      // Consumption window: last DAYS full days (data lags a day or two).
      const now = Date.now();
      const from = new Date(now - (DAYS + 2) * 86400_000).toISOString();
      const to = new Date(now).toISOString();
      let cons = [];
      for (const serial of imp.serials) {
        const qs = new URLSearchParams({ period_from: from, period_to: to, page_size: '1500', order_by: 'period' });
        try {
          const rows = await getAllPages(`/v1/electricity-meter-points/${imp.mpan}/meters/${encodeURIComponent(serial)}/consumption/?${qs}`);
          if (rows.length) { cons = cons.concat(rows); }
        } catch (e) {
          if (e.auth) throw e; // bad key: stop immediately
          /* dead serial from a meter swap: try the next one */
        }
      }
      // Keep exactly the most recent DAYS London calendar days so headings,
      // tiles and charts all describe the same window.
      if (cons.length) {
        const dayKeys = [...new Set(cons.map((r) => T.londonDateKey(Date.parse(r.interval_start))))].sort();
        const keep = new Set(dayKeys.slice(-DAYS));
        cons = cons.filter((r) => keep.has(T.londonDateKey(Date.parse(r.interval_start))));
      }
      if (!cons.length) {
        $('account-main').hidden = true;
        $('account-empty').hidden = false;
        $('account-empty-detail').textContent =
          'The account connected fine, but no half-hourly consumption came back for the last month. ' +
          'Smart-meter data lags a day or two, and half-hourly readings must be enabled on your account ' +
          '(Octopus account → data settings). Check back tomorrow.';
        setStatus(`Connected as ${state.account} — no consumption data yet.`);
        return;
      }
      cons.sort((a, b) => Date.parse(a.interval_start) - Date.parse(b.interval_start));

      // Rates for the same window: Agile for the account's region + their own tariff.
      const agileTariff = C.api.tariffCode(C.api.importProduct, region);
      const rateQs = new URLSearchParams({ period_from: from, period_to: to, page_size: '1500' });
      const agileRows = await getAllPages(
        `/v1/products/${C.api.importProduct}/electricity-tariffs/${agileTariff}/standard-unit-rates/?${rateQs}`);
      const agile = priceConsumption(cons, buildRateLookup(agileRows));

      const onAgile = !!(imp.parsed && imp.parsed.product.startsWith('AGILE'));
      let own = null, ownLabel = null, standingDeltaPencePerDay = 0;
      if (imp.parsed && !onAgile) {
        try {
          const ownRows = await getAllPages(
            `/v1/products/${imp.parsed.product}/electricity-tariffs/${imp.tariffCode}/standard-unit-rates/?${rateQs}`);
          own = priceConsumption(cons, buildRateLookup(ownRows));
          ownLabel = imp.parsed.product.startsWith('VAR') ? 'Flexible' : imp.parsed.product;
          const [ownSc, agileSc] = await Promise.all([
            authedGet(`/v1/products/${imp.parsed.product}/electricity-tariffs/${imp.tariffCode}/standing-charges/?page_size=1`),
            authedGet(`/v1/products/${C.api.importProduct}/electricity-tariffs/${agileTariff}/standing-charges/?page_size=1`),
          ]);
          const sc = (r) => (r.results && r.results[0] && r.results[0].value_inc_vat) || 0;
          standingDeltaPencePerDay = sc(ownSc) - sc(agileSc);
        } catch { /* own-tariff rates unavailable (some legacy products): compare vs Agile only */ }
      } else if (onAgile) {
        // On Agile already: still show a flat-rate reference so the tiles mean something.
        own = null;
      }

      const days = [...agile.daily.keys()].sort();
      // "Yesterday" tile wants the last COMPLETE day — consumption data ends
      // mid-day, so prefer the latest day with (nearly) all 48 slots present.
      const fullDays = days.filter((d) => agile.daily.get(d).slots >= 40);
      const result = {
        agile, own, ownLabel, onAgile, standingDeltaPencePerDay,
        dayCount: days.length,
        firstDay: days[0],
        latestDay: fullDays[fullDays.length - 1] || days[days.length - 1],
      };

      $('account-main').hidden = false;
      $('account-empty').hidden = true;
      $('forget-btn').hidden = false;
      setStatus(`Connected as ${state.account}.`);
      renderResults(summary, result);
    } catch (e) {
      if (e && e.auth) {
        setStatus('Octopus rejected the key (or it doesn’t match that account number). Check both — or regenerate the key on the Octopus site.', true);
      } else {
        setStatus(`Couldn’t load the account: ${e && e.message ? e.message : e}`, true);
      }
    } finally {
      $('connect-btn').disabled = false;
    }
  }

  // ---------- wiring ----------
  function applyTheme() {
    if (state.theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', state.theme);
    $('theme-toggle').textContent = { system: '◐ auto', light: '○ light', dark: '● dark' }[state.theme];
  }

  document.addEventListener('DOMContentLoaded', () => {
    applyTheme();
    $('theme-toggle').addEventListener('click', () => {
      state.theme = { system: 'light', light: 'dark', dark: 'system' }[state.theme];
      store.set('theme', state.theme);
      applyTheme();
    });

    $('api-key').value = state.key || '';
    $('account-number').value = state.account || '';
    $('forget-btn').hidden = !state.key;

    $('connect-form').addEventListener('submit', (e) => {
      e.preventDefault();
      state.key = $('api-key').value.trim();
      state.account = $('account-number').value.trim().toUpperCase();
      if (!state.key || !state.account) { setStatus('Both the API key and account number are needed.', true); return; }
      store.set('apikey', state.key);
      store.set('account', state.account);
      connectAndLoad();
    });

    $('forget-btn').addEventListener('click', () => {
      store.del('apikey'); store.del('account');
      state.key = ''; state.account = '';
      $('api-key').value = ''; $('account-number').value = '';
      $('account-main').hidden = true;
      $('account-empty').hidden = true;
      $('forget-btn').hidden = true;
      disposeCharts();
      setStatus('Forgotten — the key is gone from this browser. Regenerate it on the Octopus site if it may have leaked.');
    });

    if (state.key && state.account) connectAndLoad();
  });

  // exposed for tests
  window.AgileAccount = { activeAgreement, parseTariffCode, summariseAccount, buildRateLookup, priceConsumption };
})();
