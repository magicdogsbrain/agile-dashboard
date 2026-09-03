/* Chart layer (Apache ECharts 6.x).
   Import: one rect per half-hour slot, coloured by the shared price bands.
   Export: stepped line (step:'end' + duplicated terminal point so the final
   slot renders). Slot geometry always comes from valid_from/valid_to epochs —
   DST days have 46/50 slots and index arithmetic is never used. */
window.AgileCharts = (() => {
  const C = window.AGILE_CONFIG;
  const T = window.AgileTime;
  const GAP = 2; // surface gap between slot rects, px

  let importChart = null;
  let exportChart = null;
  let userZoomed = false; // once the user zooms/pans, rebuilds must not reset it
  let state = { importSlots: [], exportSlots: [], nowMs: Date.now(), best: null };

  const available = () => typeof window.echarts !== 'undefined';

  const cssVar = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const isDark = () => {
    const forced = document.documentElement.getAttribute('data-theme');
    if (forced) return forced === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  };

  const bandColor = (price) => {
    const b = window.AgileAdvisor.bandOf(price, C.bands);
    return isDark() ? b.dark : b.light;
  };

  // Plain time-of-day labels. Day boundaries are drawn from the DATA (marked
  // lines at London midnight) rather than relying on an axis tick landing on
  // London midnight — ECharts places ticks in the viewer's local timezone, so
  // a formatter keyed on a "00:00" tick never fires for non-UK viewers.
  const axisLabelFormatter = (value) => T.hm(value);

  // Epochs where the London calendar day changes, derived from the slots.
  function dayBoundaries(slots) {
    const out = [];
    for (let i = 1; i < slots.length; i++) {
      if (T.londonDateKey(slots[i].start) !== T.londonDateKey(slots[i - 1].start)) {
        out.push(slots[i].start);
      }
    }
    return out;
  }

  function slotAt(slots, ms) {
    return slots.find((s) => ms >= s.start && ms < s.end) || null;
  }

  function tooltipFormatter(params) {
    const p = Array.isArray(params) ? params[0] : params;
    if (!p) return '';
    const ms = typeof p.axisValue === 'number' ? p.axisValue : Date.parse(p.axisValue);
    const imp = slotAt(state.importSlots, ms);
    const exp = slotAt(state.exportSlots, ms);
    const rows = [];
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    if (imp) {
      const band = window.AgileAdvisor.bandOf(imp.price, C.bands);
      rows.push(`<div class="tt-row"><span class="tt-key" style="background:${bandColor(imp.price)}"></span>` +
        `<b>${imp.price.toFixed(2)}p</b>&nbsp;<span class="tt-label">import · ${esc(band.label)}</span></div>`);
    }
    if (exp) {
      rows.push(`<div class="tt-row"><span class="tt-key" style="background:${cssVar('--series-export')}"></span>` +
        `<b>${exp.price.toFixed(2)}p</b>&nbsp;<span class="tt-label">export</span></div>`);
    }
    const ref = imp || exp;
    const when = ref ? `${T.hm(ref.start)}–${T.hm(ref.end)} · ${T.dayLabel(ref.start)}` : T.full(ms);
    return `<div class="tt-when">${when}</div>${rows.join('')}`;
  }

  function makeRenderItem() {
    return (params, api) => {
      const from = api.value(0), to = api.value(1), price = api.value(2);
      const a = api.coord([from, price]);
      const b = api.coord([to, 0]);
      const x = Math.min(a[0], b[0]) + GAP / 2;
      const width = Math.max(0.75, Math.abs(b[0] - a[0]) - GAP);
      const y = Math.min(a[1], b[1]);
      const height = Math.max(0.75, Math.abs(b[1] - a[1]));
      const clipped = echarts.graphic.clipRectByRect(
        { x, y, width, height },
        { x: params.coordSys.x, y: params.coordSys.y, width: params.coordSys.width, height: params.coordSys.height },
      );
      if (!clipped) return;
      return {
        type: 'rect',
        shape: Object.assign({ r: price < 0 ? [0, 0, 3, 3] : [3, 3, 0, 0] }, clipped),
        style: { fill: bandColor(price) },
        emphasis: { style: { opacity: 0.82 } },
      };
    };
  }

  function baseOption() {
    const ink = cssVar('--text-muted');
    const grid = cssVar('--gridline');
    return {
      animation: false,
      backgroundColor: 'transparent',
      grid: { left: 44, right: 14, top: 18, bottom: 44 },
      tooltip: {
        trigger: 'axis',
        formatter: tooltipFormatter,
        backgroundColor: cssVar('--surface-1'),
        borderColor: cssVar('--hairline'),
        textStyle: { color: cssVar('--text-primary'), fontSize: 12 },
        axisPointer: { type: 'line', lineStyle: { color: cssVar('--baseline'), width: 1 } },
      },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: cssVar('--baseline') } },
        axisTick: { show: false },
        axisLabel: {
          color: ink, fontSize: 11, hideOverlap: true,
          formatter: axisLabelFormatter,
          rich: { day: { color: cssVar('--text-secondary'), fontWeight: 600, fontSize: 11 } },
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: ink, fontSize: 11, formatter: '{value}p' },
        splitLine: { lineStyle: { color: grid, width: 1 } },
        splitNumber: 4,
      },
      dataZoom: [{
        type: 'inside', filterMode: 'none',
        zoomOnMouseWheel: true, moveOnMouseMove: true, moveOnMouseWheel: false,
      }],
    };
  }

  function nowMarks(nowMs, withBest) {
    const dayLines = dayBoundaries(state.importSlots.length ? state.importSlots : state.exportSlots)
      .map((ms) => ({
        xAxis: ms,
        lineStyle: { color: cssVar('--gridline'), width: 1, type: 'solid' },
        label: {
          formatter: T.dayLabel(ms), position: 'insideStartBottom',
          color: cssVar('--text-secondary'), fontSize: 10, fontWeight: 600,
        },
      }));
    const marks = {
      markLine: {
        symbol: 'none', animation: false, silent: true,
        lineStyle: { color: cssVar('--text-secondary'), width: 1, type: 'solid' },
        label: {
          formatter: 'now', position: 'insideEndTop',
          color: cssVar('--text-secondary'), fontSize: 10, fontWeight: 600,
        },
        data: [{ xAxis: nowMs }, ...dayLines],
      },
      markArea: {
        silent: true, animation: false,
        itemStyle: { color: isDark() ? 'rgba(255,255,255,0.05)' : 'rgba(11,11,11,0.045)' },
        data: [[{ xAxis: 'min' }, { xAxis: nowMs }]],
      },
    };
    if (withBest && state.best) {
      marks.markArea.data.push([
        { xAxis: state.best.start, itemStyle: { color: isDark() ? 'rgba(57,135,229,0.16)' : 'rgba(42,120,214,0.10)' } },
        { xAxis: state.best.end },
      ]);
    }
    return marks;
  }

  function importOption() {
    const opt = baseOption();
    const data = state.importSlots.map((s) => [s.start, s.end, s.price]);
    opt.yAxis.min = (v) => Math.min(0, Math.floor(v.min));
    opt.series = [
      {
        type: 'custom', name: 'Import', renderItem: makeRenderItem(),
        data, encode: { x: [0, 1], y: 2 }, clip: true, z: 3,
      },
      // Invisible stepped twin: gives the axis pointer something dependable to
      // snap to (custom series axis-snapping is not guaranteed across versions).
      {
        type: 'line', name: '_snap', step: 'end', silent: true, z: 1,
        symbol: 'none', lineStyle: { opacity: 0 },
        data: stepData(state.importSlots),
        ...nowMarks(state.nowMs, true),
      },
    ];
    return opt;
  }

  // step:'end' needs the terminal point duplicated or the final 30-min slot vanishes.
  function stepData(slots) {
    const pts = slots.map((s) => [s.start, s.price]);
    if (slots.length) pts.push([slots[slots.length - 1].end, slots[slots.length - 1].price]);
    return pts;
  }

  function exportOption() {
    const opt = baseOption();
    const color = cssVar('--series-export');
    opt.yAxis.min = 0;
    opt.series = [
      {
        type: 'line', name: 'Export', step: 'end',
        symbol: 'none', lineStyle: { color, width: 2 },
        areaStyle: { color, opacity: 0.1 },
        data: stepData(state.exportSlots),
        ...nowMarks(state.nowMs, false),
      },
    ];
    return opt;
  }

  function visibleRange() {
    const all = state.importSlots.concat(state.exportSlots);
    if (!all.length) return null;
    const horizon = Math.max(...all.map((s) => s.end));
    const from = Math.max(Math.min(...all.map((s) => s.start)), state.nowMs - 6 * 3600_000);
    return { startValue: from, endValue: horizon };
  }

  // The window currently on screen: the user's own zoom if they've zoomed,
  // otherwise the default view. Rebuilds must never stomp a user's zoom.
  function currentRange() {
    if (userZoomed && importChart) {
      try {
        const dz = (importChart.getOption().dataZoom || [])[0];
        if (dz && dz.startValue != null && dz.endValue != null) {
          return { startValue: dz.startValue, endValue: dz.endValue };
        }
        if (dz && dz.start != null && dz.end != null) {
          return { start: dz.start, end: dz.end };
        }
      } catch { /* fall through to default range */ }
    }
    return visibleRange();
  }

  function applyAll() {
    if (!importChart) return;
    const range = currentRange();
    const impOpt = importOption();
    const expOpt = exportOption();
    if (range) {
      impOpt.dataZoom[0] = { ...impOpt.dataZoom[0], ...range };
      expOpt.dataZoom[0] = { ...expOpt.dataZoom[0], ...range };
    }
    importChart.setOption(impOpt, { notMerge: true });
    exportChart.setOption(expOpt, { notMerge: true });
  }

  function init(importEl, exportEl) {
    if (!available()) {
      // CDN blocked/offline: hide the chart cards; the rest of the page works.
      for (const el of [importEl, exportEl]) {
        const card = el && el.closest('.card');
        if (card) card.hidden = true;
      }
      return;
    }
    dispose();
    importChart = echarts.init(importEl, null, { renderer: 'canvas' });
    exportChart = echarts.init(exportEl, null, { renderer: 'canvas' });
    importChart.group = exportChart.group = 'agile';
    echarts.connect('agile');
    for (const c of [importChart, exportChart]) {
      c.on('datazoom', () => { userZoomed = true; });
    }
    applyAll();
    window.addEventListener('resize', resize);
  }

  function dispose() {
    if (importChart) { importChart.dispose(); importChart = null; }
    if (exportChart) { exportChart.dispose(); exportChart = null; }
    window.removeEventListener('resize', resize);
  }

  const resize = () => { importChart && importChart.resize(); exportChart && exportChart.resize(); };

  function render(importSlots, exportSlots, nowMs, best) {
    state = { importSlots, exportSlots, nowMs, best };
    applyAll();
  }

  // Cheap updates on the minute tick: move the now line / past shading.
  function tick(nowMs, best) {
    state.nowMs = nowMs;
    state.best = best;
    if (!importChart) return;
    importChart.setOption({ series: [{ name: '_snap', ...nowMarks(nowMs, true) }] });
    exportChart.setOption({ series: [{ name: 'Export', ...nowMarks(nowMs, false) }] });
  }

  // Theme changed: rebuild with fresh token colours.
  function retheme() { applyAll(); }

  return { init, render, tick, retheme, dispose, isDark };
})();
