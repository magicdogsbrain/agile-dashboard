/* Time helpers. All slot arithmetic uses UTC epoch ms from the API's own
   valid_from/valid_to — never index arithmetic (DST days have 46 or 50 slots). */
window.AgileTime = (() => {
  const LONDON = 'Europe/London';

  const hmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: LONDON, hour: '2-digit', minute: '2-digit' });
  const hmZoneFmt = new Intl.DateTimeFormat('en-GB', { timeZone: LONDON, hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: LONDON, weekday: 'short', day: 'numeric', month: 'short' });
  const dateKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: LONDON, year: 'numeric', month: '2-digit', day: '2-digit' });
  const fullFmt = new Intl.DateTimeFormat('en-GB', { timeZone: LONDON, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  // Local (Europe/London) calendar date of an instant, as 'YYYY-MM-DD'.
  const londonDateKey = (ms) => dateKeyFmt.format(new Date(ms));

  // On the GMT->BST/BST->GMT changeover night one wall-clock hour repeats;
  // disambiguate those labels with the zone abbreviation ("01:00 BST"/"01:00 GMT").
  function hm(ms) {
    const label = hmFmt.format(new Date(ms));
    if (hmFmt.format(new Date(ms - 3600_000)) === label ||
        hmFmt.format(new Date(ms + 3600_000)) === label) {
      return hmZoneFmt.format(new Date(ms));
    }
    return label;
  }

  const dayLabel = (ms) => dayFmt.format(new Date(ms));
  const full = (ms) => fullFmt.format(new Date(ms));

  // The London calendar day after the one containing `ms`, as 'YYYY-MM-DD'.
  // Derived from the calendar, not a fixed hour offset (23h/25h DST days).
  function londonNextDayKey(ms) {
    const [y, m, d] = londonDateKey(ms).split('-').map(Number);
    return londonDateKey(Date.UTC(y, m - 1, d + 1, 12)); // noon avoids DST edges
  }

  // "14:30" / "02:30 tomorrow" / "02:30 on Fri 5 Sep" phrasing for advisor text.
  function friendly(ms, nowMs) {
    const dThen = londonDateKey(ms);
    if (dThen === londonDateKey(nowMs)) return hm(ms);
    if (dThen === londonNextDayKey(nowMs)) return `${hm(ms)} tomorrow`;
    return `${hm(ms)} on ${dayLabel(ms)}`;
  }

  // True when the latest known slot extends into a later London calendar day
  // than "now" — i.e. tomorrow's prices have been published.
  function coversTomorrow(horizonEndMs, nowMs) {
    if (!horizonEndMs) return false;
    return londonDateKey(horizonEndMs - 60_000) > londonDateKey(nowMs);
  }

  return { londonDateKey, londonNextDayKey, hm, dayLabel, full, friendly, coversTomorrow };
})();
