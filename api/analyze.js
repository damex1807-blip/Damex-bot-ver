// DAMEX AUTOBOTS - /api/analyze?symbol=BTC/USD
// Env vars (Vercel > Settings > Environment Variables):
//   TWELVEDATA_API_KEY (required), COST_PCT (optional round-trip cost, default 0.0004 = 0.04%)

const COST_PCT = Number(process.env.COST_PCT || 0.0004);

const ema = (a, n) => { const k = 2 / (n + 1); let e = a[0]; return a.map(v => (e = v * k + e * (1 - k))); };
const rsi = (c, n = 14) => {
  let g = 0, l = 0, r = 50;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
    r = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return r;
};
const atr = (b, n = 14) => {
  let a = 0;
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
    a = i <= n ? a + tr / n : (a * (n - 1) + tr) / n;
  }
  return a;
};
const swings = (b, k = 3) => {
  const H = [], L = [];
  for (let i = k; i < b.length - k; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= k; j++) {
      if (b[i].h <= b[i - j].h || b[i].h <= b[i + j].h) hi = false;
      if (b[i].l >= b[i - j].l || b[i].l >= b[i + j].l) lo = false;
    }
    if (hi) H.push({ i, p: b[i].h });
    if (lo) L.push({ i, p: b[i].l });
  }
  return { H, L };
};
const inv = b => b.map(x => ({ t: x.t, o: -x.o, h: -x.l, l: -x.h, c: -x.c })); // mirror market so one long-logic serves both sides

async function candles(symbol, interval) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=200&timezone=UTC&apikey=${process.env.TWELVEDATA_API_KEY}`;
  const j = await (await fetch(url)).json();
  if (j.status === 'error' || !Array.isArray(j.values) || !j.values.length) throw new Error(j.message || 'Provider returned no candles');
  const bars = j.values.reverse().map(v => ({ t: v.datetime, o: +v.open, h: +v.high, l: +v.low, c: +v.close }));
  if (bars.some(x => [x.o, x.h, x.l, x.c].some(Number.isNaN))) throw new Error('Provider returned malformed candles');
  return { bars, meta: j.meta || {} };
}

// Liquidity sweep of a swing low -> close back above -> break of minor structure -> retrace entry
function longSetup(L15, H1) {
  const n = L15.length, A = atr(L15), { H, L } = swings(L15), htfHighs = swings(H1).H.map(x => x.p);
  const price = L15[n - 1].c;
  for (let i = n - 3; i >= n - 40; i--) {
    const s = L.filter(x => x.i < i - 2).at(-1);
    if (!s || !(L15[i].l < s.p && L15[i].c > s.p)) continue;
    const sweepLow = L15[i].l;
    if (Math.min(...L15.slice(i + 1).map(b => b.l)) < sweepLow) continue; // sweep low violated
    const bos = Math.max(...L15.slice(s.i, i + 1).map(b => b.h));
    if (!L15.some((b, k) => k > i && b.c > bos)) continue; // no BOS confirmation
    const leg = Math.max(...L15.slice(i).map(b => b.h));
    const entry = sweepLow + 0.5 * (leg - sweepLow);
    const stop = sweepLow - 0.25 * A;
    if (price <= stop) continue;
    const cost = entry * COST_PCT, risk = entry - stop + cost;
    const targets = [...new Set([...H.map(x => x.p), ...htfHighs, leg])]
      .filter(p => p > Math.max(entry, price)).sort((a, b) => a - b)
      .map(p => ({ p, rr: +((p - entry - cost) / risk).toFixed(2) }));
    return { entry, stop, targets, sweepLow, bosLevel: bos, atr: A };
  }
  return null;
}

module.exports = async (req, res) => {
  const symbol = String(req.query.symbol || 'BTC/USD').toUpperCase();
  if (!process.env.TWELVEDATA_API_KEY) return res.status(500).json({ error: 'TWELVEDATA_API_KEY is not set on the server' });
  try {
    const [l, h] = await Promise.all([candles(symbol, '15min'), candles(symbol, '1h')]);
    const quality = [];
    if ((l.meta.symbol || '').toUpperCase() !== symbol) quality.push(`Symbol mismatch: asked ${symbol}, provider returned ${l.meta.symbol || 'unknown'}`);
    const last = l.bars.at(-1);
    const ageMin = Math.round((Date.now() - Date.parse(last.t.replace(' ', 'T') + 'Z')) / 60000);
    const stale = ageMin > 45;
    if (stale) quality.push(`Latest 15m candle is ${ageMin} min old (market may be closed or feed delayed)`);
    if (l.bars.length < 120) quality.push(`Only ${l.bars.length} candles available`);

    const hc = h.bars.map(b => b.c);
    const bias = hc.at(-1) > ema(hc, 50).at(-1) ? 1 : -1;
    let s = bias === 1 ? longSetup(l.bars, h.bars) : longSetup(inv(l.bars), inv(h.bars));
    if (s && bias === -1) {
      s = { ...s, entry: -s.entry, stop: -s.stop, sweepLow: -s.sweepLow, bosLevel: -s.bosLevel, targets: s.targets.map(t => ({ p: -t.p, rr: t.rr })) };
    }
    const price = last.c, R = rsi(l.bars.map(b => b.c));
    let setup = null;
    if (s) {
      const tp1 = s.targets.find(t => t.rr >= 2) || null;
      const ext = s.targets.length ? s.targets[s.targets.length - 1] : null;
      setup = { side: bias === 1 ? 'LONG' : 'SHORT', entry: s.entry, stop: s.stop, tp1, extended: ext && ext.rr >= 4 ? ext : null, sweep: s.sweepLow, bos: s.bosLevel };
    }

    const pillars = {
      technical: setup && setup.tp1
        ? { status: 'OK', note: `${setup.side} after liquidity sweep + BOS, HTF bias ${bias === 1 ? 'bull' : 'bear'}, RSI ${R.toFixed(0)}` }
        : { status: 'OK', note: `HTF bias ${bias === 1 ? 'bull' : 'bear'}, RSI ${R.toFixed(0)}, no qualifying setup` },
      fundamental: { status: 'NO_DATA', note: 'No economic-calendar / news source connected yet' },
      sentiment: { status: 'NO_DATA', note: 'No sentiment / COT source connected yet' }
    };

    const reasons = [];
    if (!setup) reasons.push('No valid liquidity-sweep setup in the HTF bias direction');
    else if (!setup.tp1) reasons.push('Net risk-to-reward below 1:2 after estimated costs');
    if (stale) reasons.push('Price data is stale');
    const missing = Object.entries(pillars).filter(([, v]) => v.status !== 'OK').map(([k]) => k);
    if (missing.length) reasons.push(`Pillars without data: ${missing.join(', ')}`);
    const signal = reasons.length ? 'WAIT' : (bias === 1 ? 'BUY' : 'SELL');

    let confidence = 0;
    if (setup && setup.tp1) confidence = 50 + (setup.tp1.rr >= 3 ? 15 : 0) + (R > 30 && R < 70 ? 10 : 0) + (stale ? 0 : 10);
    if (missing.length) confidence = Math.min(confidence, 40); // incomplete evidence caps confidence

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.status(200).json({
      symbol, signal, confidence, reasons, price, asOf: last.t + ' UTC', ageMin,
      costAssumption: COST_PCT, pillars, setup, quality, candles: l.bars.slice(-70)
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
  
