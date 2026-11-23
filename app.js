/* P&L Planner dashboard.
   One page, hash-routed tabs. Reads from Supabase when signed in (supabase/migrations),
   or from invented in-browser numbers in demo mode. Both go through the same three calls:
     provider.data(from, to)   -> { facts, orders, marketing, opex, meta }
     provider.orders(filter)   -> { rows, count }
     provider.lines(orderId)   -> [ line, ... ]
   All percentages are of net revenue (revenue after tax).
   Filters (market, 3PL, collection) apply to every tab. Marketing is recorded by market only and
   OPEX by month only, so under a 3PL or collection filter they are shared out by net revenue. */
(function () {
'use strict';

var CFG = window.PL_CONFIG || {};
var CUR = CFG.CURRENCY_SYMBOL || '£';
var DAY = 864e5;
var PAGE = 50;

/* ---------- helpers ---------- */
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function ms(s) { return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)); }
function iso(t) { return new Date(t).toISOString().slice(0, 10); }
function addDays(s, n) { return iso(ms(s) + n * DAY); }
function today() { var d = new Date(); return iso(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); }
function daysBetween(a, b) { return Math.round((ms(b) - ms(a)) / DAY) + 1; }
function monthEnd(s) { return iso(Date.UTC(+s.slice(0, 4), +s.slice(5, 7), 0)); }
function money(n) { return (n < 0 ? '−' : '') + CUR + Math.round(Math.abs(n)).toLocaleString('en-GB'); }
function money2(n) {
  return (n < 0 ? '−' : '') + CUR + Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function num(n) { return Math.round(n).toLocaleString('en-GB'); }
function pct(a, b) { return b ? (a / b * 100).toFixed(1) + '%' : '–'; }
function ratio(a, b) { return b ? a / b : 0; }
function fmtDay(s, withYear) {
  var o = { day: 'numeric', month: 'short', timeZone: 'UTC' };
  if (withYear) o.year = 'numeric';
  return new Date(ms(s)).toLocaleDateString('en-GB', o);
}
function cssVar(name) { return 'var(' + name + ')'; }

var COSTS = [
  { k: 'cogs', n: 'COGS (FIFO, landed)', c: '--c-cogs' },
  { k: 'pp',   n: 'Pick & pack',         c: '--c-pp' },
  { k: 'ship', n: 'Shipping',            c: '--c-ship' },
  { k: 'fee',  n: 'Payment fees',        c: '--c-fee' }
];
var TABS = [
  ['overview', 'Overview'], ['funnel', 'Marketing funnel'], ['markets', 'By market'], ['threepl', 'By 3PL'], ['collections', 'By collection'],
  ['orders', 'Orders'], ['costs', 'Costs'], ['marketing', 'Marketing & OPEX'], ['notes', 'Data notes']
];
var PRESETS = [
  ['week', 'This week'], ['4w', 'Last 4 weeks'], ['month', 'This month'],
  ['lastmonth', 'Last month'], ['90d', 'Last 90 days'], ['ytd', 'Year to date']
];
var ORDER_SORTS = { order_date: 1, units: 1, net_revenue: 1, cogs: 1, pick_pack: 1, shipping: 1, payment_fee: 1, gross_profit: 1 };

var state = {
  tab: 'overview', preset: '4w', from: '', to: '', gran: 'day',
  f: { m: '', t: '', c: '' },          // filters: market, 3PL, collection
  stack: [],                           // earlier date ranges, for the Back button
  sort: {},                            // table sorts, by table key
  data: null, sync: [], funnel: null, hidden: {}, charts: {}, who: '', mode: '',
  ord: { page: 0, q: '', sort: 'order_date', dir: 'desc', open: null, rows: [], count: 0, lines: {}, loading: false }
};
var sb = null, provider = null;

/* ---------- demo data (invented, in the browser only) ---------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function r2(n) { return Math.round(n * 100) / 100; }

function demoProvider() {
  var rnd = mulberry32(42);
  var SK = [
    ['S-BAG-TOTE-BLK', 'Sample tote bag, black', 'Bags', 89, 21.5], ['S-BAG-TOTE-TAN', 'Sample tote bag, tan', 'Bags', 89, 22.1],
    ['S-BAG-CROSS-BLK', 'Sample crossbody bag, black', 'Bags', 69, 16.4], ['S-BAG-CROSS-OLV', 'Sample crossbody bag, olive', 'Bags', 69, 16.9],
    ['S-BAG-MINI-RED', 'Sample mini bag, red', 'Bags', 55, 12.8], ['S-CASE-HARD-BLK', 'Sample hard glasses case', 'Glasses cases', 29, 5.6],
    ['S-CASE-SOFT-TAN', 'Sample soft glasses case', 'Glasses cases', 24, 4.2], ['S-CASE-FOLD-NVY', 'Sample folding glasses case', 'Glasses cases', 32, 6.9],
    ['S-STRAP-WIDE', 'Sample wide strap', 'Straps', 22, 3.8], ['S-STRAP-CHAIN', 'Sample chain strap', 'Straps', 26, 5.1],
    ['S-ACC-CHARM', 'Sample bag charm', 'Accessories', 14, 2.1], ['S-ACC-POUCH', 'Sample zip pouch', 'Accessories', 18, 3.4]
  ];
  var TAX = { UK: 1 / 6, EU: 0.16, AU: 1 / 11 };
  var SHIP = { UK: 3.2, US: 7.5, EU: 5.8, AU: 9.5, CA: 8.4, ROW: 11 };
  var COUNTRY = { UK: 'GB', US: 'US', AU: 'AU', CA: 'CA', ROW: 'AE' };
  var end = addDays(today(), -1), orders = [], ads = [], opex = [], seq = 0;

  for (var i = 0; i < 180; i++) {
    var d = addDays(end, i - 179);
    var dow = new Date(ms(d)).getUTCDay();
    var cnt = Math.round(46 + 20 * rnd() + (dow === 0 || dow === 6 ? 10 : 0) + i / 12);
    var netByMarket = {};
    for (var n = 0; n < cnt; n++) {
      var rm = rnd(), rc = rnd(), rl = rnd(), rs = rnd(), rg = rnd();
      var m = rm < .42 ? 'UK' : rm < .67 ? 'US' : rm < .82 ? 'EU' : rm < .90 ? 'AU' : rm < .95 ? 'CA' : 'ROW';
      var t = (m === 'UK' || (m === 'EU' && rc < .3)) ? 'B3PL' : 'PORTLESS';
      var nl = rl < .6 ? 1 : rl < .9 ? 2 : 3;
      var matched = t === 'B3PL' ? rs < .8 : rs < .65;
      var o = { id: 900000000000 + (++seq), name: '#S' + (10000 + seq), d: d, m: m, t: t,
                country: COUNTRY[m] || (rc < .4 ? 'DE' : rc < .75 ? 'FR' : 'NL'), lines: [] };
      for (var k = 1; k <= nl; k++) {
        var s = SK[Math.floor(rnd() * SK.length)], rq = rnd(), rd = rnd(), rcost = rnd();
        var qty = rq < .1 ? 2 : 1;
        var rev = r2(s[3] * qty * (1 - (rd < .35 ? 0.10 + 0.10 * rd : 0)));
        var tax = r2(rev * (TAX[m] || 0));
        o.lines.push({
          sku: s[0], qty: qty, threepl: t, revenue: rev, tax: tax,
          cogs: r2(s[4] * qty * (0.95 + 0.10 * rcost)), cogs_src: rcost < .2 ? 'estimate' : 'actual',
          pick_pack: r2((k === 1 ? (t === 'B3PL' ? 1.85 : 1.40) : (t === 'B3PL' ? 0.45 : 0.30)) * qty),
          pick_pack_src: matched ? 'actual' : 'estimate',
          shipping: r2(SHIP[m] * (0.85 + 0.30 * rg) / nl), shipping_src: matched ? 'actual' : 'estimate',
          payment_fee: r2(rev * (m === 'UK' ? 0.019 : 0.029) + (k === 1 ? (m === 'UK' ? 0.20 : 0.25) : 0)),
          payment_fee_src: rc < .85 ? 'actual' : 'estimate',
          skus: { name: s[1], collection: s[2] }
        });
        netByMarket[m] = (netByMarket[m] || 0) + rev - tax;
      }
      if (rg < .12) {
        o.lines.push({ sku: 'S-GIFT-CLOTH', qty: 1, threepl: t, revenue: 0, tax: 0, cogs: 0.9, cogs_src: 'actual',
          pick_pack: 0.3, pick_pack_src: 'estimate', shipping: 0, shipping_src: 'actual', payment_fee: 0, payment_fee_src: 'actual',
          skus: { name: 'Sample free gift: lens cloth', collection: 'Free gifts' } });
      }
      orders.push(o);
    }
    Object.keys(netByMarket).forEach(function (mk) {
      [['Meta', .6], ['Google', .3], ['TikTok', .1]].forEach(function (p) {
        ads.push({ d: d, m: mk, p: p[0], s: r2(netByMarket[mk] * 0.24 * p[1] * (0.8 + 0.4 * rnd())) });
      });
    });
  }
  var mo = addDays(end, -179).slice(0, 7) + '-01';
  while (mo <= end) {
    [['Salaries', 14000], ['Agency and freelancers', 3500], ['Software', 2100], ['Rent and office', 1200], ['Other', 900]]
      .forEach(function (c) { opex.push({ month: mo, cat: c[0], amt: c[1] }); });
    mo = addDays(monthEnd(mo), 1);
  }
  var meta = {
    sample: true, min: addDays(end, -179), max: end,
    markets: [['UK', 'United Kingdom'], ['US', 'United States'], ['EU', 'Europe'], ['AU', 'Australia'], ['CA', 'Canada'], ['ROW', 'Rest of world']]
      .map(function (x) { return { code: x[0], name: x[1] }; }),
    threepls: [{ code: 'B3PL', name: 'B3PL (UK)' }, { code: 'PORTLESS', name: 'Portless' }]
  };
  function orderRow(o) {
    var r = { order_id: o.id, order_name: o.name, order_date: o.d, market: o.m, ship_country: o.country, threepls: o.t,
              units: 0, revenue: 0, tax: 0, cogs: 0, pick_pack: 0, shipping: 0, payment_fee: 0, has_estimate: false };
    o.lines.forEach(function (l) {
      r.units += l.qty; r.revenue += l.revenue; r.tax += l.tax; r.cogs += l.cogs;
      r.pick_pack += l.pick_pack; r.shipping += l.shipping; r.payment_fee += l.payment_fee;
      if (l.cogs_src === 'estimate' || l.pick_pack_src === 'estimate' || l.shipping_src === 'estimate' || l.payment_fee_src === 'estimate') r.has_estimate = true;
    });
    r.net_revenue = r.revenue - r.tax;
    r.gross_profit = r.net_revenue - r.cogs - r.pick_pack - r.shipping - r.payment_fee;
    return r;
  }
  return {
    data: function (from, to) {
      var f = {}, oc = {};
      orders.forEach(function (o) {
        if (o.d < from || o.d > to) return;
        var ok = o.d + '|' + o.m + '|' + o.t;
        (oc[ok] = oc[ok] || { d: o.d, m: o.m, t: o.t, o: 0 }).o++;
        var seen = {};
        o.lines.forEach(function (l) {
          var c = l.skus.collection, key = ok + '|' + c;
          var x = f[key] = f[key] || { d: o.d, m: o.m, t: o.t, c: c, o: 0, u: 0, rev: 0, tax: 0, cogs: 0, cogs_e: 0, pp: 0, pp_e: 0, ship: 0, ship_e: 0, fee: 0, fee_e: 0 };
          if (!seen[c]) { seen[c] = 1; x.o++; }
          x.u += l.qty; x.rev += l.revenue; x.tax += l.tax;
          x.cogs += l.cogs; if (l.cogs_src === 'estimate') x.cogs_e += l.cogs;
          x.pp += l.pick_pack; if (l.pick_pack_src === 'estimate') x.pp_e += l.pick_pack;
          x.ship += l.shipping; if (l.shipping_src === 'estimate') x.ship_e += l.shipping;
          x.fee += l.payment_fee; if (l.payment_fee_src === 'estimate') x.fee_e += l.payment_fee;
        });
      });
      return Promise.resolve({
        facts: Object.keys(f).map(function (k) { return f[k]; }),
        orders: Object.keys(oc).map(function (k) { return oc[k]; }),
        marketing: ads.filter(function (a) { return a.d >= from && a.d <= to; }),
        opex: opex.filter(function (x) { return x.month <= to && monthEnd(x.month) >= from; }),
        meta: meta
      });
    },
    orders: function (q) {
      var rows = orders.filter(function (o) {
        return o.d >= q.from && o.d <= q.to && (!q.market || o.m === q.market) && (!q.threepl || o.t === q.threepl) &&
               (!q.q || o.name.toLowerCase().indexOf(q.q.toLowerCase()) >= 0);
      }).map(orderRow);
      var dir = q.dir === 'asc' ? 1 : -1, col = q.sort;
      rows.sort(function (a, b) { return (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : a.order_id - b.order_id) * dir; });
      return Promise.resolve({ count: rows.length, rows: rows.slice(q.page * PAGE, q.page * PAGE + PAGE) });
    },
    lines: function (id) {
      var o = orders.filter(function (x) { return x.id === id; })[0];
      return Promise.resolve(o ? o.lines : []);
    },
    sync: function () { return Promise.resolve([]); },
    /* Invented funnel figures in the same shape as the real ones, so the tab can be seen in the demo. */
    funnel: function (from, to) {
      var day = {}, cat = {}, MK = { UK: 1, US: 1, AU: 1 };
      orders.forEach(function (o) {
        if (o.d < from || o.d > to || !MK[o.m]) return;
        var k = o.d + '|' + o.m, r = day[k] = day[k] || { day: o.d, market: o.m, meta_spend: 0, google_spend: 0, applovin_spend: 0, ad_spend: 0, shopify_sales: 0, new_customer_sales: 0, net_revenue: 0, contribution: 0 };
        o.lines.forEach(function (l) {
          r.shopify_sales += l.revenue; r.new_customer_sales += l.revenue * 0.82; r.net_revenue += l.revenue - l.tax;
          r.contribution += l.revenue - l.tax - l.cogs - l.pick_pack - l.shipping - l.payment_fee;
          var c = l.skus.collection === 'Glasses cases' ? 'Glasses cases' : l.skus.collection === 'Bags' ? 'Bags' : null;
          if (!c) return;
          var ck = k + '|' + c, x = cat[ck] = cat[ck] || { day: o.d, market: o.m, category: c, meta_spend: 0, google_spend: 0, applovin_spend: 0, new_sales: 0, returning_sales: 0 };
          x.new_sales += l.revenue * 0.82; x.returning_sales += l.revenue * 0.18;
        });
      });
      ads.forEach(function (a) {
        var r = day[a.d + '|' + a.m]; if (!r) return;
        var f = a.p === 'Meta' ? 'meta_spend' : a.p === 'Google' ? 'google_spend' : 'applovin_spend';
        r[f] += a.s; r.ad_spend += a.s; r.contribution -= a.s;
        ['Bags', 'Glasses cases'].forEach(function (c, i) { var x = cat[a.d + '|' + a.m + '|' + c]; if (x) x[f] += a.s * (i ? 0.2 : 0.7); });
      });
      var costs = [];
      opex.forEach(function (x) {
        if (x.cat === 'Software' && x.month <= to && monthEnd(x.month) >= from) {
          [['Sample store platform', 0.45], ['Sample email tool', 0.3], ['Sample reporting tool', 0.25]].forEach(function (i) { costs.push({ month: x.month, item: i[0], amount: r2(x.amt * i[1]), currency: 'GBP', is_total: false }); });
          costs.push({ month: x.month, item: 'TOTAL', amount: x.amt, currency: 'GBP', is_total: true });
        }
      });
      return Promise.resolve({
        daily: Object.keys(day).map(function (k) { return day[k]; }), category: Object.keys(cat).map(function (k) { return cat[k]; }),
        monthly: [], costs: costs, meta: { sample: true, source: 'sample generator', exported_at: null, min: meta.min, max: meta.max }
      });
    }
  };
}

/* ---------- Supabase data ---------- */
function sbProvider() {
  function check(res) { if (res.error) throw new Error(res.error.message); return res; }
  return {
    data: function (from, to) {
      return sb.rpc('pl_data', { p_from: from, p_to: to }).then(function (res) { return check(res).data; });
    },
    orders: function (q) {
      var x = sb.from('order_pl').select('*', { count: 'exact' })
        .gte('order_date', q.from).lte('order_date', q.to)
        .order(q.sort, { ascending: q.dir === 'asc' }).order('order_id', { ascending: false })
        .range(q.page * PAGE, q.page * PAGE + PAGE - 1);
      if (q.market) x = x.eq('market', q.market);
      if (q.threepl) x = x.ilike('threepls', '%' + q.threepl + '%');
      if (q.q) x = x.ilike('order_name', '%' + q.q.replace(/[%_,()]/g, '') + '%');
      return x.then(function (res) { check(res); return { rows: res.data, count: res.count || 0 }; });
    },
    lines: function (id) {
      return sb.from('order_lines').select('*, skus(name, collection)').eq('order_id', id).order('id')
        .then(function (res) { return check(res).data; });
    },
    /* Which live sheets feed the database and when each last synced. */
    sync: function () {
      return sb.rpc('sync_status').then(function (res) { return res.error ? [] : (res.data || []); }, function () { return []; });
    },
    /* Real figures from the client's Daily Funnel Sheet. */
    funnel: function (from, to) {
      return sb.rpc('funnel_data', { p_from: from, p_to: to }).then(function (res) { return res.error ? null : res.data; }, function () { return null; });
    },
    /* Ask the database to read the live sheets right now instead of waiting for the schedule. */
    syncNow: function () {
      return sb.functions.invoke('sync-sheets', { body: {} }).then(function (res) {
        if (res.error) throw new Error(res.error.message || 'the sync could not be started');
        return res.data || {};
      });
    }
  };
}

/* ---------- P&L maths ---------- */
var ZERO = ['o', 'u', 'rev', 'tax', 'cogs', 'cogs_e', 'pp', 'pp_e', 'ship', 'ship_e', 'fee', 'fee_e'];
function blank() { var z = {}; ZERO.forEach(function (k) { z[k] = 0; }); return z; }
function addFact(z, r) { ZERO.forEach(function (k) { z[k] += +r[k] || 0; }); }

/* Filter tests. `skip` leaves one filter out, so a "by market" table still lists every market. */
function okM(r, skip) { return skip === 'm' || !state.f.m || r.m === state.f.m; }
function okT(r, skip) { return skip === 't' || !state.f.t || r.t === state.f.t; }
function okC(r, skip) { return skip === 'c' || !state.f.c || r.c === state.f.c; }
function anyFilter() { return !!(state.f.m || state.f.t || state.f.c); }

function opexFor(from, to) {
  var total = 0, by = {};
  (state.data.opex || []).forEach(function (x) {
    var a = x.month > from ? x.month : from, me = monthEnd(x.month), b = me < to ? me : to;
    if (a > b) return;
    var part = (+x.amt) * daysBetween(a, b) / daysBetween(x.month, me);
    total += part; by[x.cat] = (by[x.cat] || 0) + part;
  });
  return { total: total, by: by };
}
function finish(z, orders, mkt, opex) {
  z.orders = orders; z.net = z.rev - z.tax;
  z.gp = z.net - z.cogs - z.pp - z.ship - z.fee;
  z.mkt = mkt; z.con = z.gp - mkt; z.opex = opex; z.np = z.con - opex;
  z.costs = z.cogs + z.pp + z.ship + z.fee;
  z.est = z.cogs_e + z.pp_e + z.ship_e + z.fee_e;
  return z;
}
/* A running tally for one slice of time, honouring the filters. */
function tally() { return { z: blank(), orders: 0, mktM: 0, netAll: 0, netM: 0 }; }
function tallyFact(t, r) {
  var net = (+r.rev) - (+r.tax);
  t.netAll += net;
  if (okM(r)) { t.netM += net; if (okT(r) && okC(r)) addFact(t.z, r); }
}
function tallyDone(t, opexTotal) {
  var f = state.f, net = t.z.rev - t.z.tax;
  var mkt = (f.t || f.c) ? t.mktM * ratio(net, t.netM) : t.mktM;
  var opex = anyFilter() ? opexTotal * ratio(net, t.netAll) : opexTotal;
  return finish(t.z, f.c ? t.z.o : t.orders, mkt, opex);
}
function period(from, to) {
  var t = tally();
  state.data.facts.forEach(function (r) { if (r.d >= from && r.d <= to) tallyFact(t, r); });
  state.data.orders.forEach(function (r) { if (r.d >= from && r.d <= to && okM(r) && okT(r)) t.orders += +r.o; });
  state.data.marketing.forEach(function (r) { if (r.d >= from && r.d <= to && okM(r)) t.mktM += +r.s; });
  return tallyDone(t, opexFor(from, to).total);
}
function prevRange() {
  var len = daysBetween(state.from, state.to), pto = addDays(state.from, -1);
  return { from: addDays(pto, -(len - 1)), to: pto };
}
/* Groups the current period by market (m), 3PL (t) or collection (c). */
function byDim(key) {
  var g = {}, ord = {}, mk = {}, base = {}, mktM = 0, netM = 0, from = state.from, to = state.to, f = state.f;
  state.data.facts.forEach(function (r) {
    if (r.d < from || r.d > to || !okM(r, key)) return;
    var net = (+r.rev) - (+r.tax);
    netM += net; base[r.m] = (base[r.m] || 0) + net;
    if (okT(r, key) && okC(r, key)) addFact(g[r[key]] = g[r[key]] || blank(), r);
  });
  state.data.orders.forEach(function (r) {
    if (r.d >= from && r.d <= to && okM(r, key) && okT(r, key)) ord[r[key]] = (ord[r[key]] || 0) + (+r.o);
  });
  state.data.marketing.forEach(function (r) {
    if (r.d < from || r.d > to || !okM(r, key)) return;
    mktM += +r.s; mk[r.m] = (mk[r.m] || 0) + (+r.s);
  });
  return Object.keys(g).map(function (name) {
    var z = g[name], net = z.rev - z.tax;
    var mkt = key === 'm' ? (mk[name] || 0) * ratio(net, base[name]) : mktM * ratio(net, netM);
    z = finish(z, (key === 'c' || f.c) ? z.o : (ord[name] || 0), mkt, 0); z.name = name; return z;
  });
}
function sumRows(rows) {
  var z = blank(), orders = 0, mkt = 0;
  rows.forEach(function (r) { addFact(z, r); orders += r.orders; mkt += r.mkt; });
  return finish(z, orders, mkt, 0);
}
function bucketOf(d) {
  if (state.gran === 'month') return d.slice(0, 7) + '-01';
  if (state.gran === 'week') return addDays(d, -((new Date(ms(d)).getUTCDay() + 6) % 7));
  return d;
}
function series() {
  var keys = [], map = {}, d;
  for (d = state.from; d <= state.to; d = addDays(d, 1)) {
    var b = bucketOf(d);
    if (!map[b]) { map[b] = tally(); map[b].first = d; keys.push(b); }
    map[b].last = d;
  }
  state.data.facts.forEach(function (r) { if (r.d >= state.from && r.d <= state.to) tallyFact(map[bucketOf(r.d)], r); });
  state.data.orders.forEach(function (r) { if (r.d >= state.from && r.d <= state.to && okM(r) && okT(r)) map[bucketOf(r.d)].orders += +r.o; });
  state.data.marketing.forEach(function (r) { if (r.d >= state.from && r.d <= state.to && okM(r)) map[bucketOf(r.d)].mktM += +r.s; });
  return keys.map(function (k) {
    var x = map[k], z = tallyDone(x, opexFor(x.first, x.last).total);
    z.first = x.first; z.last = x.last;
    z.label = state.gran === 'month' ? new Date(ms(k)).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }) : fmtDay(k);
    z.tip = state.gran === 'day' ? fmtDay(k, true) : state.gran === 'week' ? fmtDay(x.first) + ' to ' + fmtDay(x.last, true) : z.label;
    return z;
  });
}
function nameOf(list, code) {
  var hit = (state.data.meta[list] || []).filter(function (x) { return x.code === code; })[0];
  return hit ? hit.name : code;
}
function collections() {
  var seen = {};
  state.data.facts.forEach(function (r) { seen[r.c] = 1; });
  return Object.keys(seen).sort();
}

/* ---------- small render pieces ---------- */
function delta(cur, prev, neutral) {
  if (!prev) return '<span class="muted">no earlier period</span>';
  var ch = (cur - prev) / Math.abs(prev) * 100;
  var cls = neutral ? 'muted' : (ch >= 0 ? 'up' : 'down');
  return '<span class="' + cls + '">' + (ch >= 0 ? '▲ ' : '▼ ') + Math.abs(ch).toFixed(1) + '%</span> <span class="muted">vs previous</span>';
}
function kpi(label, value, sub, go) {
  return '<div class="kpi' + (go ? ' go' : '') + '"' + (go ? ' data-go="' + go + '" tabindex="0" role="link"' : '') + '><div class="k">' + esc(label) +
         '</div><div class="v">' + value + '</div><div class="s">' + sub + '</div></div>';
}
function hbar(label, parts, total, valueText, attrs) {
  var fills = parts.map(function (p) {
    return '<span class="fill" style="width:' + (total ? Math.max(0, p[0]) / total * 100 : 0).toFixed(2) + '%;background:' + cssVar(p[1]) + '"></span>';
  }).join('');
  return '<div class="hbar' + (attrs ? ' pick' : '') + '"' + (attrs || '') + '><span>' + esc(label) + '</span><span class="track">' + fills + '</span><span class="val">' + valueText + '</span></div>';
}
function granPicker() {
  return '<div class="seg">' + [['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(function (g) {
    return '<button type="button" data-gran="' + g[0] + '" class="' + (state.gran === g[0] ? 'on' : '') + '">' + g[1] + '</button>';
  }).join('') + '</div>';
}
function sortHead(table, col, label, cls) {
  var s = state.sort[table] || {}, on = s.col === col;
  return '<th class="sortable' + (cls ? ' ' + cls : '') + '" data-sort="' + table + '|' + col + '" tabindex="0" aria-sort="' + (on ? (s.dir > 0 ? 'ascending' : 'descending') : 'none') + '">' +
         label + (on ? (s.dir > 0 ? ' ▲' : ' ▼') : '') + '</th>';
}

/* Bars + lines chart in SVG: clickable legend, hover read-out, click a bar to zoom in. */
function drawChart(hostId, buckets, list, fmt) {
  var host = $(hostId); if (!host) return;
  var hid = state.hidden[hostId] = state.hidden[hostId] || {};
  var labels = buckets.map(function (b) { return b.label; });
  var vis = list.filter(function (s) { return !hid[s.name]; });
  var W = Math.max(320, host.clientWidth), H = 260, L = 60, R = 10, T = 10, B = 24;
  var max = 0, min = 0;
  vis.forEach(function (s) { s.values.forEach(function (v) { if (v > max) max = v; if (v < min) min = v; }); });
  if (max === min) max = min + 1;
  var n = labels.length, bw = (W - L - R) / Math.max(1, n);
  function y(v) { return T + (H - T - B) * (1 - (v - min) / (max - min)); }
  var out = '';
  for (var i = 0; i <= 4; i++) {
    var v = min + (max - min) * i / 4;
    out += '<line class="gridl" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>' +
           '<text x="' + (L - 6) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + esc(fmt(v)) + '</text>';
  }
  if (min < 0) out += '<line class="gridl zero" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(0) + '" y2="' + y(0) + '"/>';
  var step = Math.ceil(n / 12);
  labels.forEach(function (lb, i) {
    if (i % step === 0) out += '<text x="' + (L + i * bw + bw / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(lb) + '</text>';
  });
  out += '<rect class="hl" x="0" y="' + T + '" width="' + bw + '" height="' + (H - T - B) + '" visibility="hidden"/>';
  vis.forEach(function (s) {
    if (s.type === 'bar') {
      s.values.forEach(function (v, i) {
        var y0 = y(0), y1 = y(v);
        out += '<rect x="' + (L + i * bw + bw * .15) + '" width="' + Math.max(1, bw * .7) + '" y="' + Math.min(y0, y1) + '" height="' + Math.abs(y1 - y0) +
               '" fill="' + cssVar(s.color) + '" opacity=".85"/>';
      });
    } else {
      out += '<polyline fill="none" stroke="' + cssVar(s.color) + '" stroke-width="2" points="' +
        s.values.map(function (v, i) { return (L + i * bw + bw / 2) + ',' + y(v); }).join(' ') + '"/>';
      if (n <= 45) s.values.forEach(function (v, i) {
        out += '<circle cx="' + (L + i * bw + bw / 2) + '" cy="' + y(v) + '" r="3" fill="' + cssVar(s.color) + '"/>';
      });
    }
  });
  host.innerHTML =
    '<div class="legend">' + list.map(function (s) {
      return '<button type="button" data-chart="' + hostId + '" data-series="' + esc(s.name) + '" class="' + (hid[s.name] ? 'off' : '') +
             '" aria-pressed="' + (!hid[s.name]) + '"><i style="background:' + cssVar(s.color) + '"></i>' + esc(s.name) + '</button>';
    }).join('') + '<span class="small muted">hover for figures, click a bar to zoom in</span></div>' +
    '<div class="chart-wrap"><svg class="chart" data-plot="' + hostId + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Chart">' + out +
    '</svg><div class="tip" hidden></div></div>';
  state.charts[hostId] = { buckets: buckets, vis: vis, fmt: fmt, W: W, L: L, bw: bw, n: n };
}
function chartIndex(svg, e) {
  var c = state.charts[svg.dataset.plot]; if (!c) return null;
  var box = svg.getBoundingClientRect();
  var x = (e.clientX - box.left) * c.W / box.width;
  var i = Math.floor((x - c.L) / c.bw);
  return (i < 0 || i >= c.n) ? null : { c: c, i: i, box: box };
}
function chartHover(svg, e) {
  var hit = chartIndex(svg, e), tip = svg.parentNode.querySelector('.tip'), hl = svg.querySelector('.hl');
  if (!hit) { tip.hidden = true; hl.setAttribute('visibility', 'hidden'); return; }
  var c = hit.c, i = hit.i;
  hl.setAttribute('x', c.L + i * c.bw); hl.setAttribute('visibility', 'visible');
  tip.innerHTML = '<b>' + esc(c.buckets[i].tip) + '</b>' + c.vis.map(function (s) {
    return '<div><i style="background:' + cssVar(s.color) + '"></i>' + esc(s.name) + '<span>' + esc(c.fmt(s.values[i])) + '</span></div>';
  }).join('');
  tip.hidden = false;
  var px = (c.L + (i + .5) * c.bw) * hit.box.width / c.W;
  tip.style.left = Math.min(Math.max(4, px + 12), hit.box.width - tip.offsetWidth - 4) + 'px';
}

/* ---------- tabs ---------- */
function renderOverview() {
  var cur = period(state.from, state.to), pr = prevRange(), prev = period(pr.from, pr.to);
  var actualShare = cur.costs ? (cur.costs - cur.est) / cur.costs : 0;
  var html = '<div class="stack"><div class="kpis">' +
    kpi('Net revenue', money(cur.net), delta(cur.net, prev.net), 'markets') +
    kpi('Gross profit', money(cur.gp), pct(cur.gp, cur.net) + ' margin · ' + delta(cur.gp, prev.gp), 'costs') +
    kpi('Contribution', money(cur.con), pct(cur.con, cur.net) + ' · ' + delta(cur.con, prev.con), 'marketing') +
    kpi('Net profit', money(cur.np), pct(cur.np, cur.net) + ' · ' + delta(cur.np, prev.np), 'marketing') +
    kpi('Orders', num(cur.orders), delta(cur.orders, prev.orders), 'orders') +
    kpi('Net revenue per order', cur.orders ? money2(cur.net / cur.orders) : '–', delta(ratio(cur.net, cur.orders), ratio(prev.net, prev.orders)), 'orders') +
    kpi('Costs on actuals', (actualShare * 100).toFixed(0) + '%', 'the rest is estimated', 'notes') +
    '</div>';

  var rows = [
    ['Revenue (after discounts and refunds)', cur.rev, prev.rev, '', '', ''],
    ['Tax by market', -cur.tax, -prev.tax, 'sub', '', 'markets'],
    ['Net revenue', cur.net, prev.net, 'total', '', ''],
    ['COGS (FIFO, landed)', -cur.cogs, -prev.cogs, 'sub', '--c-cogs', 'costs'],
    ['Pick & pack', -cur.pp, -prev.pp, 'sub', '--c-pp', 'costs'],
    ['Shipping', -cur.ship, -prev.ship, 'sub', '--c-ship', 'costs'],
    ['Payment fees', -cur.fee, -prev.fee, 'sub', '--c-fee', 'costs'],
    ['Gross profit', cur.gp, prev.gp, 'total', '', ''],
    ['Marketing', -cur.mkt, -prev.mkt, 'sub', '--c-mkt', 'marketing'],
    ['Contribution', cur.con, prev.con, 'total', '', ''],
    ['OPEX', -cur.opex, -prev.opex, 'sub', '--c-opex', 'marketing'],
    ['Net profit', cur.np, prev.np, 'total', '', '']
  ];
  html += '<div class="grid g2"><div class="panel"><div class="panel-head"><h3>P&amp;L ladder</h3><span class="small muted">% of net revenue · select a cost line to open it</span></div><div class="scroll"><table><thead><tr><th>Line</th><th>Amount</th><th>%</th><th>Previous</th><th>Prev %</th></tr></thead><tbody>' +
    rows.map(function (r) {
      return '<tr class="' + r[3] + (r[5] ? ' click' : '') + '"' + (r[5] ? ' data-go="' + r[5] + '" tabindex="0"' : '') + '><td>' + (r[4] ? '<i class="dot" style="background:' + cssVar(r[4]) + '"></i>' : '') + esc(r[0]) + '</td><td>' + money(r[1]) +
             '</td><td class="pct">' + pct(Math.abs(r[1]), cur.net) + '</td><td>' + money(r[2]) + '</td><td class="pct">' + pct(Math.abs(r[2]), prev.net) + '</td></tr>';
    }).join('') + '</tbody></table></div></div>';

  var parts = COSTS.map(function (c) { return [c.n, cur[c.k], c.c]; }).concat([['Marketing', cur.mkt, '--c-mkt'], ['OPEX', cur.opex, '--c-opex']]);
  var biggest = Math.max.apply(null, parts.map(function (p) { return p[1]; }).concat([1]));
  html += '<div class="panel"><div class="panel-head"><h3>Where each ' + esc(CUR) + '1 of net revenue goes</h3></div>' +
    parts.map(function (p) { return hbar(p[0], [[p[1], p[2]]], biggest, pct(p[1], cur.net)); }).join('') +
    hbar('Net profit', [[cur.np, '--c-np']], biggest, pct(cur.np, cur.net)) +
    '<p class="note">Bars are sized against the largest cost. The figure is each line as a share of net revenue.</p></div></div>';

  html += '<div class="panel"><div class="panel-head"><h3>Revenue and profit over time</h3>' + granPicker() + '</div><div id="chMain"></div></div>';
  html += '<div class="panel"><div class="panel-head"><h3>Daily net revenue</h3><span class="small muted">brighter = higher · select a day to see its orders</span></div><div id="heat" class="heat"></div></div></div>';
  $('view').innerHTML = html;

  var s = series();
  drawChart('chMain', s, [
    { name: 'Net revenue', type: 'bar', color: '--c-rev', values: s.map(function (x) { return x.net; }) },
    { name: 'Gross profit', type: 'line', color: '--c-gp', values: s.map(function (x) { return x.gp; }) },
    { name: 'Contribution', type: 'line', color: '--c-con', values: s.map(function (x) { return x.con; }) },
    { name: 'Net profit', type: 'line', color: '--c-np', values: s.map(function (x) { return x.np; }) }
  ], money);

  var daily = {}, max = 0, cells = '', d;
  state.data.facts.forEach(function (r) {
    if (r.d >= state.from && r.d <= state.to && okM(r) && okT(r) && okC(r)) daily[r.d] = (daily[r.d] || 0) + (+r.rev) - (+r.tax);
  });
  Object.keys(daily).forEach(function (k) { if (daily[k] > max) max = daily[k]; });
  var pad = (new Date(ms(state.from)).getUTCDay() + 6) % 7;
  for (var i = 0; i < pad; i++) cells += '<i style="visibility:hidden"></i>';
  for (d = state.from; d <= state.to; d = addDays(d, 1)) {
    var v = daily[d] || 0;
    cells += '<i data-day="' + d + '" tabindex="0" role="button" aria-label="' + esc(fmtDay(d, true) + ', ' + money(v)) + '" title="' + esc(fmtDay(d, true) + ': ' + money(v)) +
             '" style="background:color-mix(in srgb, var(--c-gp) ' + (max ? Math.round(12 + 88 * v / max) : 0) + '%, var(--panel2))"></i>';
  }
  $('heat').innerHTML = cells;
}

var DIM_COLS = {
  name: function (r) { return r.label.toLowerCase(); }, orders: function (r) { return r.orders; }, net: function (r) { return r.net; },
  cogs: function (r) { return ratio(r.cogs, r.net); }, pp: function (r) { return ratio(r.pp, r.net); },
  ship: function (r) { return ratio(r.ship, r.net); }, fee: function (r) { return ratio(r.fee, r.net); },
  gp: function (r) { return r.gp; }, gpp: function (r) { return ratio(r.gp, r.net); }, mkt: function (r) { return r.mkt; },
  con: function (r) { return r.con; }, conp: function (r) { return ratio(r.con, r.net); }
};
function renderDim(key, title, list) {
  var rows = byDim(key), tot = sumRows(rows), sel = state.f[key];
  rows.forEach(function (r) { r.label = list ? nameOf(list, r.name) : r.name; });
  var s = state.sort[key] || { col: 'net', dir: -1 }, get = DIM_COLS[s.col] || DIM_COLS.net;
  rows.sort(function (a, b) { var x = get(a), y = get(b); return (x < y ? -1 : x > y ? 1 : 0) * s.dir; });
  var line = function (name, r, cls, attrs) {
    return '<tr class="' + cls + '"' + (attrs || '') + '><td>' + esc(name) + '</td><td>' + num(r.orders) + '</td><td>' + money(r.net) + '</td><td class="pct">' + pct(r.net, tot.net) + '</td>' +
      COSTS.map(function (c) { return '<td class="pct">' + pct(r[c.k], r.net) + '</td>'; }).join('') +
      '<td>' + money(r.gp) + '</td><td class="pct">' + pct(r.gp, r.net) + '</td><td>' + money(r.mkt) + '</td><td>' + money(r.con) + '</td><td class="pct">' + pct(r.con, r.net) + '</td></tr>';
  };
  var pick = function (r) { return ' data-filter="' + key + '|' + esc(r.name) + '" tabindex="0" aria-pressed="' + (sel === r.name) + '"'; };
  var max = Math.max.apply(null, rows.map(function (r) { return r.net; }).concat([1]));
  var what = title.replace(/^by /, '');
  var html = '<div class="stack"><div class="panel"><div class="panel-head"><h3>Net revenue and what is left after order costs, ' + esc(title) + '</h3>' +
    '<span class="legend"><button type="button" disabled><i style="background:var(--c-gp)"></i>Gross profit</button><button type="button" disabled><i style="background:var(--c-rev)"></i>Order costs</button></span></div>' +
    rows.map(function (r) {
      return hbar(r.label, [[r.gp, '--c-gp'], [r.net - Math.max(0, r.gp), '--c-rev']], max, money(r.net), pick(r) + (sel === r.name ? ' data-on="1"' : ''));
    }).join('') + '<p class="note">Select a ' + esc(what) + ' to filter the whole dashboard to it. Select it again to clear.</p></div>' +
    '<div class="panel"><div class="panel-head"><h3>P&amp;L ' + esc(title) + '</h3><span class="small muted">cost columns are % of that row’s net revenue · select a heading to sort</span></div><div class="scroll"><table><thead><tr>' +
    sortHead(key, 'name', esc(what.charAt(0).toUpperCase() + what.slice(1))) + sortHead(key, 'orders', 'Orders') + sortHead(key, 'net', 'Net revenue') + '<th>Share</th>' +
    sortHead(key, 'cogs', 'COGS') + sortHead(key, 'pp', 'Pick &amp; pack') + sortHead(key, 'ship', 'Shipping') + sortHead(key, 'fee', 'Pay fees') +
    sortHead(key, 'gp', 'Gross profit') + sortHead(key, 'gpp', 'GP %') + sortHead(key, 'mkt', 'Marketing') + sortHead(key, 'con', 'Contribution') + sortHead(key, 'conp', 'Contr %') +
    '</tr></thead><tbody>' +
    rows.map(function (r) { return line(r.label, r, 'click' + (sel === r.name ? ' sel' : ''), pick(r)); }).join('') + line('Total', tot, 'total') + '</tbody></table></div>' +
    '<p class="note">' + (key === 'm' && !state.f.t && !state.f.c
      ? 'Marketing is the actual ad spend recorded against each market.'
      : 'Marketing is recorded by market only, so here it is shared out by net revenue.') + ' OPEX is left out of this view.' +
    (key === 'c' || state.f.c ? ' Orders counts orders that contain the collection, so an order with two collections appears in both rows.' : '') + '</p></div></div>';
  $('view').innerHTML = html;
}

function renderCosts() {
  var cur = period(state.from, state.to), pr = prevRange(), prev = period(pr.from, pr.to);
  var html = '<div class="stack"><div class="kpis">' + COSTS.map(function (c) {
    return kpi(c.n, money(cur[c.k]), pct(cur[c.k], cur.net) + ' of net revenue (was ' + pct(prev[c.k], prev.net) + ') · ' +
      (cur.orders ? money2(cur[c.k] / cur.orders) : '–') + ' per order');
  }).join('') + '</div>';
  html += '<div class="panel"><div class="panel-head"><h3>Each cost as % of net revenue</h3>' + granPicker() + '</div><div id="chCost"></div></div>';
  html += '<div class="panel"><div class="panel-head"><h3>Actual or estimated</h3><span class="legend"><button type="button" disabled><i style="background:var(--good)"></i>Actual (invoice or payout)</button><button type="button" disabled><i style="background:var(--warn)"></i>Estimated (rate card or model)</button></span></div>' +
    COSTS.map(function (c) {
      var e = cur[c.k + '_e'], a = cur[c.k] - e;
      return hbar(c.n, [[a, '--good'], [e, '--warn']], cur[c.k], pct(a, cur[c.k]) + ' actual');
    }).join('') + '<p class="note">An estimate is replaced by the actual when the invoice or payout is loaded.</p></div></div>';
  $('view').innerHTML = html;
  var s = series();
  drawChart('chCost', s, COSTS.map(function (c) {
    return { name: c.n, type: 'line', color: c.c, values: s.map(function (x) { return x.net ? x[c.k] / x.net * 100 : 0; }) };
  }), function (v) { return v.toFixed(1) + '%'; });
}

function renderMarketing() {
  var cur = period(state.from, state.to), plat = {}, ox = opexFor(state.from, state.to), platTotal = 0;
  state.data.marketing.forEach(function (r) { if (r.d >= state.from && r.d <= state.to && okM(r)) { plat[r.p] = (plat[r.p] || 0) + (+r.s); platTotal += +r.s; } });
  var scale = ratio(cur.mkt, platTotal), oxScale = ratio(cur.opex, ox.total);
  var pk = Object.keys(plat).sort(function (a, b) { return plat[b] - plat[a]; });
  var mrows = byDim('m').sort(function (a, b) { return b.net - a.net; });
  var html = '<div class="stack"><div class="kpis">' +
    kpi('Marketing spend', money(cur.mkt), pct(cur.mkt, cur.net) + ' of net revenue') +
    kpi('Net revenue per ' + CUR + '1 of spend', cur.mkt ? (cur.net / cur.mkt).toFixed(2) : '–', 'net revenue ÷ marketing') +
    kpi('Contribution', money(cur.con), pct(cur.con, cur.net) + ' of net revenue') +
    kpi('OPEX', money(cur.opex), pct(cur.opex, cur.net) + ' of net revenue') +
    kpi('Net profit', money(cur.np), pct(cur.np, cur.net) + ' of net revenue') + '</div>';
  html += '<div class="grid g2"><div class="panel"><div class="panel-head"><h3>Spend by platform</h3></div>' +
    (pk.length ? pk.map(function (p) { return hbar(p, [[plat[p], '--c-mkt']], plat[pk[0]], money(plat[p] * scale)); }).join('') : '<p class="muted">No ad spend in this period.</p>') + '</div>';
  html += '<div class="panel"><div class="panel-head"><h3>OPEX in this period</h3><span class="small muted">monthly figures, shared by day</span></div><div class="scroll"><table><thead><tr><th>Category</th><th>Amount</th><th>%</th></tr></thead><tbody>' +
    Object.keys(ox.by).sort(function (a, b) { return ox.by[b] - ox.by[a]; }).map(function (c) {
      return '<tr><td>' + esc(c) + '</td><td>' + money(ox.by[c] * oxScale) + '</td><td class="pct">' + pct(ox.by[c] * oxScale, cur.net) + '</td></tr>';
    }).join('') + '<tr class="total"><td>Total</td><td>' + money(cur.opex) + '</td><td class="pct">' + pct(cur.opex, cur.net) + '</td></tr></tbody></table></div></div></div>';
  html += '<div class="panel"><div class="panel-head"><h3>Marketing by market</h3><span class="small muted">select a market to filter the dashboard</span></div><div class="scroll"><table><thead><tr><th>Market</th><th>Spend</th><th>Net revenue</th><th>Spend %</th><th>Gross profit</th><th>Contribution</th><th>Contr %</th></tr></thead><tbody>' +
    mrows.map(function (r) {
      return '<tr class="click' + (state.f.m === r.name ? ' sel' : '') + '" data-filter="m|' + esc(r.name) + '" tabindex="0"><td>' + esc(nameOf('markets', r.name)) + '</td><td>' + money(r.mkt) + '</td><td>' + money(r.net) + '</td><td class="pct">' + pct(r.mkt, r.net) +
             '</td><td>' + money(r.gp) + '</td><td>' + money(r.con) + '</td><td class="pct">' + pct(r.con, r.net) + '</td></tr>';
    }).join('') + '</tbody></table></div></div></div>';
  $('view').innerHTML = html;
}

/* Marketing funnel: real figures from the client's Daily Funnel Sheet (not sample data). */
function renderFunnel() {
  var F = state.funnel, fm = state.f.m;
  if (!F) {
    $('view').innerHTML = '<div class="panel prose"><h3>Marketing funnel</h3><p>' + (state.mode === 'demo'
      ? 'This tab shows real figures from the Daily Funnel Sheet, so it is not part of the demo. Sign in to see it.'
      : 'No funnel figures are available. They may still be loading, or none have been loaded yet.') + '</p></div>';
    return;
  }
  var N = function (v) { return +v || 0; };
  var daily = F.daily.filter(function (r) { return !fm || r.market === fm; });
  var tot = { spend: 0, meta: 0, google: 0, app: 0, sales: 0, nc: 0, net: 0, con: 0 }, byM = {}, byDay = {}, keys = [];
  var add = function (o, r) {
    o.meta += N(r.meta_spend); o.google += N(r.google_spend); o.app += N(r.applovin_spend);
    o.spend += r.ad_spend != null ? N(r.ad_spend) : N(r.meta_spend) + N(r.google_spend) + N(r.applovin_spend);
    o.sales += N(r.shopify_sales); o.nc += N(r.new_customer_sales); o.net += N(r.net_revenue); o.con += N(r.contribution);
  };
  var zero = function () { return { spend: 0, meta: 0, google: 0, app: 0, sales: 0, nc: 0, net: 0, con: 0 }; };
  for (var d = state.from; d <= state.to; d = addDays(d, 1)) {
    var b = bucketOf(d);
    if (!byDay[b]) { byDay[b] = zero(); byDay[b].first = d; keys.push(b); }
    byDay[b].last = d;
  }
  daily.forEach(function (r) {
    add(tot, r); add(byM[r.market] = byM[r.market] || zero(), r);
    if (byDay[bucketOf(r.day)]) add(byDay[bucketOf(r.day)], r);
  });
  var x = function (a, b) { return b ? (a / b).toFixed(2) + 'x' : '–'; };
  var when = F.meta.exported_at ? new Date(F.meta.exported_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'unknown';
  var html = '<div class="stack"><p class="small muted">' + (F.meta.sample
    ? '<span class="badge warn">SAMPLE DATA</span> Invented figures for the demo. Signed in, this tab shows the real Daily Funnel Sheet. Figures run from '
    : '<span class="badge">REAL DATA</span> From the client’s ' + esc(F.meta.source || 'Daily Funnel Sheet') + ', copied ' + esc(when) + '. Figures run from ') + (F.meta.min ? esc(fmtDay(String(F.meta.min), true)) : '–') + ' to ' + (F.meta.max ? esc(fmtDay(String(F.meta.max), true)) : '–') +
    '. This is a copy taken on request, not a live link. Sales include VAT; net revenue excludes it.</p>';
  if (!daily.length) {
    $('view').innerHTML = html + '<div class="panel"><p class="muted">No funnel figures for this period' + (fm ? ' and market' : '') + '. The 3PL and collection filters do not apply to this tab.</p></div></div>';
    return;
  }
  html += '<div class="kpis">' +
    kpi('Ad spend', money(tot.spend), pct(tot.spend, tot.net) + ' of net revenue') +
    kpi('Shopify sales', money(tot.sales), 'inc. VAT') +
    kpi('Net revenue', money(tot.net), 'ex VAT') +
    kpi('Contribution after ads', money(tot.con), pct(tot.con, tot.net) + ' of net revenue') +
    kpi('Blended ROAS', x(tot.sales, tot.spend), 'sales ÷ ad spend') +
    kpi('New-customer ROAS', x(tot.nc, tot.spend), 'new-customer sales ÷ ad spend') +
    kpi('New-customer share', pct(tot.nc, tot.sales), 'of Shopify sales') + '</div>';
  html += '<div class="panel"><div class="panel-head"><h3>Sales, ad spend and contribution over time</h3>' + granPicker() + '</div><div id="chFunnel"></div></div>';

  var mk = Object.keys(byM).sort(function (a, b) { return byM[b].sales - byM[a].sales; });
  html += '<div class="panel"><div class="panel-head"><h3>By market</h3><span class="small muted">select a market to filter the dashboard</span></div><div class="scroll"><table><thead><tr><th>Market</th><th>Meta</th><th>Google</th><th>AppLovin</th><th>Ad spend</th><th>Shopify sales</th><th>Net revenue</th><th>Contribution</th><th>Contr %</th><th>ROAS</th><th>New-cust ROAS</th></tr></thead><tbody>' +
    mk.map(function (m) {
      var r = byM[m];
      return '<tr class="click' + (fm === m ? ' sel' : '') + '" data-filter="m|' + esc(m) + '" tabindex="0"><td>' + esc(nameOf('markets', m)) + '</td><td>' + money(r.meta) + '</td><td>' + money(r.google) + '</td><td>' + money(r.app) +
        '</td><td>' + money(r.spend) + '</td><td>' + money(r.sales) + '</td><td>' + money(r.net) + '</td><td>' + money(r.con) + '</td><td class="pct">' + pct(r.con, r.net) + '</td><td>' + x(r.sales, r.spend) + '</td><td>' + x(r.nc, r.spend) + '</td></tr>';
    }).join('') + '</tbody></table></div></div>';

  var cat = {};
  F.category.forEach(function (r) {
    if (fm && r.market !== fm) return;
    var k = r.market + '|' + r.category, o = cat[k] = cat[k] || { market: r.market, category: r.category, spend: 0, nw: 0, ret: 0 };
    o.spend += N(r.meta_spend) + N(r.google_spend) + N(r.applovin_spend); o.nw += N(r.new_sales); o.ret += N(r.returning_sales);
  });
  var cats = Object.keys(cat).map(function (k) { return cat[k]; }).sort(function (a, b) { return (b.nw + b.ret) - (a.nw + a.ret); });
  var catSpend = cats.reduce(function (s, c) { return s + c.spend; }, 0);
  html += '<div class="grid g2"><div class="panel"><div class="panel-head"><h3>Bags vs glasses cases</h3><span class="small muted">ad spend matched to a product category</span></div>' + (cats.length
    ? '<div class="scroll"><table><thead><tr><th>Market</th><th class="l">Category</th><th>Ad spend</th><th>New-cust sales</th><th>Returning sales</th><th>ROAS</th></tr></thead><tbody>' +
      cats.map(function (c) {
        return '<tr><td>' + esc(c.market) + '</td><td class="l">' + esc(c.category) + '</td><td>' + money(c.spend) + '</td><td>' + money(c.nw) + '</td><td>' + money(c.ret) + '</td><td>' + x(c.nw + c.ret, c.spend) + '</td></tr>';
      }).join('') + '</tbody></table></div><p class="note">Spend matched to a category here is ' + money(catSpend) + ' of ' + money(tot.spend) + ' total ad spend (' + pct(catSpend, tot.spend) +
      '). The rest is not tied to bags or glasses cases in the sheet.</p>'
    : '<p class="muted">No category figures for this period (they start later than the market figures).</p>') + '</div>';

  var costs = {}, months = {}, sheetTotal = 0, usd = 0;
  F.costs.forEach(function (c) {
    if (c.month > state.to || monthEnd(c.month) < state.from) return;
    months[c.month] = 1;
    if (c.is_total) { sheetTotal += N(c.amount); return; }
    if (c.currency === 'USD') { usd += N(c.amount); return; }
    costs[c.item] = (costs[c.item] || 0) + N(c.amount);
  });
  var items = Object.keys(costs).sort(function (a, b) { return costs[b] - costs[a]; });
  html += '<div class="panel"><div class="panel-head"><h3>App and software costs</h3><span class="small muted">whole months touching this period</span></div>' + (items.length || sheetTotal
    ? '<div class="scroll"><table><thead><tr><th>Item</th><th>Amount</th></tr></thead><tbody>' +
      items.slice(0, 14).map(function (i) { return '<tr><td>' + esc(i) + '</td><td>' + money2(costs[i]) + '</td></tr>'; }).join('') +
      (items.length > 14 ? '<tr><td class="muted">' + (items.length - 14) + ' smaller items</td><td>' + money2(items.slice(14).reduce(function (s, i) { return s + costs[i]; }, 0)) + '</td></tr>' : '') +
      (sheetTotal ? '<tr class="total"><td>Sheet’s own total</td><td>' + money2(sheetTotal) + '</td></tr>' : '') + '</tbody></table></div>' +
      '<p class="note">These are app and software costs only, not all overheads.' + (usd ? ' Items billed in dollars ($' + num(usd) + ') are not in the list above; the sheet’s total converts them.' : '') +
      ' Months covered: ' + Object.keys(months).length + '.</p>'
    : '<p class="muted">The sheet has no app costs entered for this period.</p>') + '</div></div></div>';
  $('view').innerHTML = html;

  var s = keys.map(function (k) {
    var o = byDay[k];
    o.label = state.gran === 'month' ? new Date(ms(k)).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }) : fmtDay(k);
    o.tip = state.gran === 'day' ? fmtDay(k, true) : state.gran === 'week' ? fmtDay(o.first) + ' to ' + fmtDay(o.last, true) : o.label;
    return o;
  });
  drawChart('chFunnel', s, [
    { name: 'Shopify sales', type: 'bar', color: '--c-rev', values: s.map(function (o) { return o.sales; }) },
    { name: 'Ad spend', type: 'line', color: '--c-mkt', values: s.map(function (o) { return o.spend; }) },
    { name: 'Contribution after ads', type: 'line', color: '--c-gp', values: s.map(function (o) { return o.con; }) }
  ], money);
}

function renderOrders() {
  var o = state.ord, body;
  var head = function (col, label, cls) {
    var on = o.sort === col;
    return '<th class="sortable' + (cls ? ' ' + cls : '') + '" data-osort="' + col + '" tabindex="0" aria-sort="' + (on ? (o.dir === 'asc' ? 'ascending' : 'descending') : 'none') + '">' +
           label + (on ? (o.dir === 'asc' ? ' ▲' : ' ▼') : '') + '</th>';
  };
  if (o.loading && !o.rows.length) body = '<tr><td colspan="12" class="l muted">Loading…</td></tr>';
  else if (!o.rows.length) body = '<tr><td colspan="12" class="l muted">No orders match.</td></tr>';
  else body = o.rows.map(function (r) {
    var open = o.open === r.order_id, out =
      '<tr class="click" data-order="' + esc(r.order_id) + '" tabindex="0" aria-expanded="' + open + '"><td>' + (open ? '▾ ' : '▸ ') + esc(r.order_name) + '</td><td class="l">' + esc(fmtDay(r.order_date, true)) +
      '</td><td class="l">' + esc(r.market) + '</td><td class="l">' + esc(r.threepls || '') + '</td><td>' + num(r.units) + '</td><td>' + money2(+r.net_revenue) +
      '</td><td>' + money2(+r.cogs) + '</td><td>' + money2(+r.pick_pack) + '</td><td>' + money2(+r.shipping) + '</td><td>' + money2(+r.payment_fee) +
      '</td><td>' + money2(+r.gross_profit) + ' <span class="pct">' + pct(+r.gross_profit, +r.net_revenue) + '</span></td><td class="l">' +
      (r.has_estimate ? '<span class="tag est">has estimates</span>' : '<span class="tag">all actual</span>') + '</td></tr>';
    if (open) {
      var ls = o.lines[r.order_id];
      var src = function (v, s) { return money2(+v) + (s === 'estimate' ? ' <span class="tag est">est</span>' : ''); };
      out += '<tr class="lines"><td colspan="12" class="l">' + (!ls ? 'Loading lines…' :
        '<table><thead><tr><th>SKU</th><th class="l">Product</th><th class="l">Collection</th><th>Qty</th><th>Revenue</th><th>Tax</th><th>COGS</th><th>Pick &amp; pack</th><th>Shipping</th><th>Pay fee</th><th>Gross profit</th></tr></thead><tbody>' +
        ls.map(function (l) {
          var gp = (+l.revenue) - (+l.tax) - (+l.cogs) - (+l.pick_pack) - (+l.shipping) - (+l.payment_fee);
          return '<tr><td>' + esc(l.sku) + '</td><td class="l">' + esc(l.skus ? l.skus.name : '') + '</td><td class="l">' + esc(l.skus ? l.skus.collection : 'Unmapped') +
            '</td><td>' + num(l.qty) + '</td><td>' + money2(+l.revenue) + '</td><td>' + money2(+l.tax) + '</td><td>' + src(l.cogs, l.cogs_src) + '</td><td>' + src(l.pick_pack, l.pick_pack_src) +
            '</td><td>' + src(l.shipping, l.shipping_src) + '</td><td>' + src(l.payment_fee, l.payment_fee_src) + '</td><td>' + money2(gp) + '</td></tr>';
        }).join('') + '</tbody></table>') + '</td></tr>';
    }
    return out;
  }).join('');
  var pages = Math.max(1, Math.ceil(o.count / PAGE));
  $('view').innerHTML = '<div class="panel"><div class="panel-head"><h3>Orders in this period</h3><div class="filters">' +
    '<input id="oQ" type="search" placeholder="Order number" aria-label="Order number" value="' + esc(o.q) + '"></div></div>' +
    '<div class="scroll"><table><thead><tr><th>Order</th>' + head('order_date', 'Date', 'l') + '<th class="l">Market</th><th class="l">3PL</th>' + head('units', 'Units') + head('net_revenue', 'Net revenue') +
    head('cogs', 'COGS') + head('pick_pack', 'Pick &amp; pack') + head('shipping', 'Shipping') + head('payment_fee', 'Pay fees') + head('gross_profit', 'Gross profit') + '<th class="l">Source</th></tr></thead><tbody>' +
    body + '</tbody></table></div><div class="pager"><span class="muted">' + num(o.count) + ' orders · page ' + (o.page + 1) + ' of ' + pages + '</span>' +
    '<button class="btn small" type="button" id="oPrev"' + (o.page ? '' : ' disabled') + '>Previous</button>' +
    '<button class="btn small" type="button" id="oNext"' + (o.page + 1 < pages ? '' : ' disabled') + '>Next</button></div>' +
    '<p class="note">Select an order to see each line and where every cost came from. Select a heading to sort. Marketing and OPEX are not on individual orders.' +
    (state.f.c ? ' The collection filter does not apply to this list.' : '') + '</p></div>';
}
function loadOrders() {
  var o = state.ord; o.loading = true; o.open = null;
  if (state.tab === 'orders') renderOrders();
  return provider.orders({ from: state.from, to: state.to, market: state.f.m, threepl: state.f.t, q: o.q, page: o.page, sort: o.sort, dir: o.dir })
    .then(function (res) { o.rows = res.rows || []; o.count = res.count || 0; })
    .catch(function (e) { o.rows = []; o.count = 0; setStatus('Could not load orders: ' + e.message); })
    .then(function () { o.loading = false; if (state.tab === 'orders') renderOrders(); });
}

function renderNotes() {
  var cur = period(state.from, state.to), m = state.data.meta;
  $('view').innerHTML = '<div class="stack"><div class="panel prose">' +
    '<h3>What you are looking at</h3>' +
    (m.sample ? '<p><span class="badge warn">SAMPLE DATA</span> Every number on this dashboard is invented so the layout can be checked. Nothing here comes from the client’s systems yet.</p>' : '') +
    '<p>Data covers ' + (m.min ? esc(fmtDay(String(m.min), true)) + ' to ' + esc(fmtDay(String(m.max), true)) : 'no dates yet') + '.</p>' +
    '<h3>Live sheets</h3>' + (state.sync.length
      ? '<div class="scroll"><table><thead><tr><th>Sheet</th><th class="l">Tab</th><th>Rows</th><th class="l">Last synced</th><th class="l">Status</th></tr></thead><tbody>' +
        state.sync.map(function (s) {
          var bad = s.last_status === 'error';
          return '<tr><td>' + esc(s.name) + '</td><td class="l">' + esc(s.tab) + '</td><td>' + num(+s.rows || 0) + '</td><td class="l">' +
            (s.last_ok ? esc(new Date(s.last_ok).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) : 'never') + '</td><td class="l">' +
            (!s.enabled ? '<span class="tag">switched off</span>' : bad ? '<span class="tag est">problem</span> ' + esc(s.last_message || '') : s.last_status ? '<span class="tag">ok</span>' : '<span class="tag">waiting for first run</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div><p class="muted small">Sheets are read every 15 minutes. This page refreshes itself every 5 minutes.</p>'
      : '<p>No live sheets are connected yet' + (state.mode === 'demo' ? ' (not shown in the demo).' : '. The receiving side is ready; sheets appear here once they are shared and listed.') + '</p>') +
    (state.mode === 'live' ? '<p><button class="btn small" type="button" id="syncNow"' + (state.syncing ? ' disabled' : '') + '>' + (state.syncing ? 'Syncing…' : 'Sync now') + '</button> <span class="small muted" role="status">' + esc(state.syncMsg || '') + '</span></p>' : '') +
    '<h3>Getting around</h3><ul>' +
    '<li>Use the Market, 3PL and Collection filters at the top, or select a row or bar on the By market, By 3PL and By collection tabs. A filter applies to every tab until you clear it.</li>' +
    '<li>Hover a chart for the figures. Select a bar to zoom in to that day, week or month; use Back to return.</li>' +
    '<li>Select a square in the daily calendar to see that day’s orders.</li>' +
    '<li>Select a column heading to sort a table, and a tile or a cost line on the Overview to open its detail.</li></ul>' +
    '<h3>Definitions</h3><ul>' +
    '<li><b>Revenue</b>: sales after discounts and refunds, tax still included.</li>' +
    '<li><b>Net revenue</b>: revenue minus the tax that belongs to the ship-to market. Every percentage on the dashboard is a share of net revenue.</li>' +
    '<li><b>Gross profit</b>: net revenue minus COGS, pick &amp; pack, shipping and payment fees. These four are stored on each order line.</li>' +
    '<li><b>Contribution</b>: gross profit minus marketing. Ad spend is recorded by day, market and platform.</li>' +
    '<li><b>Net profit</b>: contribution minus OPEX. OPEX is entered per month and shared evenly across the days of that month.</li>' +
    '<li><b>When a filter is on</b>: marketing is exact for a market. For a 3PL or collection it is shared out by net revenue, and so is OPEX under any filter.</li>' +
    '<li><b>Previous period</b>: the same number of days immediately before the selected range.</li></ul>' +
    '<h3>Actual or estimated</h3><p>Each cost on each order line is marked actual (from an invoice or payout) or estimated (from a rate card or model). In the selected period ' +
    pct(cur.costs - cur.est, cur.costs) + ' of order costs are actuals.</p>' +
    '<div class="scroll"><table><thead><tr><th>Cost</th><th>Total</th><th>Actual</th><th>Estimated</th><th>Actual %</th></tr></thead><tbody>' +
    COSTS.map(function (c) {
      var e = cur[c.k + '_e'];
      return '<tr><td>' + esc(c.n) + '</td><td>' + money(cur[c.k]) + '</td><td>' + money(cur[c.k] - e) + '</td><td>' + money(e) + '</td><td class="pct">' + pct(cur[c.k] - e, cur[c.k]) + '</td></tr>';
    }).join('') + '</tbody></table></div>' +
    '<h3>Not built yet</h3><ul>' +
    '<li>Loading real orders, invoices, payouts and ad spend. The tables are ready; the imports are the next piece of work.</li>' +
    '<li>The FIFO engine that works out landed cost per unit. For now COGS is a number stored on the order line.</li>' +
    '<li>Reconciliation against payouts and the bank, and the bridge to Lifetimely and Profitably.</li>' +
    '<li>Export to PowerPoint or a spreadsheet.</li></ul></div></div>';
}

/* ---------- shell ---------- */
function setStatus(t) { $('status').textContent = t || ''; }
function renderFilters() {
  var meta = state.data.meta, f = state.f;
  var sel = function (id, label, items, cur) {
    return '<label>' + label + ' <select id="' + id + '"><option value="">All</option>' + items.map(function (x) {
      return '<option value="' + esc(x.code) + '"' + (x.code === cur ? ' selected' : '') + '>' + esc(x.name) + '</option>';
    }).join('') + '</select></label>';
  };
  $('filters').innerHTML =
    sel('fM', 'Market', meta.markets || [], f.m) + sel('fT', '3PL', meta.threepls || [], f.t) +
    sel('fC', 'Collection', collections().map(function (c) { return { code: c, name: c }; }), f.c) +
    (anyFilter() ? '<button class="btn small" type="button" id="fClear">Clear filters</button>' : '') +
    (state.stack.length ? '<button class="btn small" type="button" id="back">← Back to ' + esc(fmtDay(state.stack[state.stack.length - 1].from)) + ' – ' + esc(fmtDay(state.stack[state.stack.length - 1].to)) + '</button>' : '') +
    (state.f.t || state.f.c ? '<span class="small muted">Filtered view: marketing and OPEX are shared out by net revenue.</span>'
      : state.f.m ? '<span class="small muted">Filtered view: OPEX is shared out by net revenue.</span>' : '');
}
function render() {
  var title = TABS.filter(function (t) { return t[0] === state.tab; })[0] || TABS[0];
  state.tab = title[0];
  $('tabTitle').textContent = title[1];
  $('tabs').innerHTML = TABS.map(function (t) {
    return '<a href="#' + t[0] + '" class="' + (t[0] === state.tab ? 'on' : '') + '"' + (t[0] === state.tab ? ' aria-current="page"' : '') + '>' + t[1] + '</a>';
  }).join('');
  $('presets').innerHTML = PRESETS.map(function (p) {
    return '<button type="button" data-preset="' + p[0] + '" class="' + (state.preset === p[0] ? 'on' : '') + '">' + p[1] + '</button>';
  }).join('');
  $('from').value = state.from; $('to').value = state.to;
  var pr = prevRange(), len = daysBetween(state.from, state.to);
  $('rangeNote').textContent = len + (len === 1 ? ' day' : ' days') + ', compared with ' + fmtDay(pr.from) + ' to ' + fmtDay(pr.to, true);
  if (!state.data) return;
  $('sampleBadge').hidden = !state.data.meta.sample;
  $('demoBadge').hidden = state.mode !== 'demo';
  renderFilters();
  state.charts = {};
  if (state.tab === 'overview') renderOverview();
  else if (state.tab === 'funnel') renderFunnel();
  else if (state.tab === 'markets') renderDim('m', 'by market', 'markets');
  else if (state.tab === 'threepl') renderDim('t', 'by 3PL', 'threepls');
  else if (state.tab === 'collections') renderDim('c', 'by collection', null);
  else if (state.tab === 'orders') renderOrders();
  else if (state.tab === 'costs') renderCosts();
  else if (state.tab === 'marketing') renderMarketing();
  else renderNotes();
}
function applyPreset(p) {
  var t = today(), f = t;
  if (p === 'week') f = addDays(t, -((new Date(ms(t)).getUTCDay() + 6) % 7));
  else if (p === '4w') f = addDays(t, -27);
  else if (p === 'month') f = t.slice(0, 7) + '-01';
  else if (p === 'lastmonth') { t = addDays(t.slice(0, 7) + '-01', -1); f = t.slice(0, 7) + '-01'; }
  else if (p === '90d') f = addDays(t, -89);
  else if (p === 'ytd') f = t.slice(0, 4) + '-01-01';
  /* Ranges that run up to now stop at yesterday, the last complete day. */
  if (p !== 'lastmonth' && addDays(t, -1) >= f) { t = addDays(t, -1); if (p === '4w' || p === '90d') f = addDays(f, -1); }
  state.preset = p; state.from = f; state.to = t;
}
/* Narrow the date range (from a chart bar or a calendar day), remembering where we came from. */
function zoom(from, to, tab) {
  state.stack.push({ from: state.from, to: state.to, preset: state.preset, gran: state.gran, tab: state.tab });
  state.preset = ''; state.from = from; state.to = to;
  if (daysBetween(from, to) <= 31) state.gran = 'day';
  if (tab && tab !== state.tab) { state.tab = tab; history.replaceState(null, '', '#' + tab); }
  load();
}
function goBack() {
  var s = state.stack.pop(); if (!s) return;
  state.from = s.from; state.to = s.to; state.preset = s.preset; state.gran = s.gran;
  if (s.tab !== state.tab) { state.tab = s.tab; history.replaceState(null, '', '#' + s.tab); }
  load();
}
function setFilter(key, value) {
  state.f[key] = state.f[key] === value ? '' : value;
  state.ord.page = 0;
  render();
  if (key !== 'c') loadOrders();
}
function go(tab) { location.hash = tab; }
function load() {
  var pr = prevRange();
  setStatus('Loading…');
  state.ord.page = 0;
  return provider.data(pr.from, state.to).then(function (d) {
    d.facts = d.facts || []; d.orders = d.orders || []; d.marketing = d.marketing || []; d.opex = d.opex || []; d.meta = d.meta || {};
    state.data = d;
    setStatus(d.facts.length ? '' : 'No orders in this period.');
    render();
    provider.sync().then(function (s) { state.sync = s || []; if (state.tab === 'notes') render(); });
    provider.funnel(state.from, state.to).then(function (f) { state.funnel = f; if (state.tab === 'funnel') render(); });
    return loadOrders();
  }).catch(function (e) {
    setStatus('Could not load the data: ' + e.message + '. If you are signed in but see this, your email may not be on the allowed list.');
    render();
  });
}
function start(p, who, mode) {
  provider = p; state.who = who; state.mode = mode;
  state.stack = []; state.f = { m: '', t: '', c: '' };
  $('signin').hidden = true; $('app').hidden = false;
  $('who').textContent = who;
  $('signOut').textContent = mode === 'demo' ? 'Leave demo' : 'Sign out';
  state.tab = (location.hash || '#overview').slice(1);
  applyPreset(state.preset || '4w');
  load();
}
function showSignin(msg) {
  $('app').hidden = true; $('signin').hidden = false;
  $('siMsg').textContent = msg || (sb ? '' : 'Sign-in is not available right now (the sign-in library did not load). The demo still works.');
}

/* ---------- events ---------- */
function act(t, e) {
  var d = t.dataset;
  if (d.preset) { state.stack = []; applyPreset(d.preset); load(); }
  else if (d.gran) { state.gran = d.gran; render(); }
  else if (d.chart) { var h = state.hidden[d.chart]; h[d.series] = !h[d.series]; render(); }
  else if (d.filter) { var p = d.filter.split('|'); setFilter(p[0], p.slice(1).join('|')); }
  else if (d.sort) {
    var s = d.sort.split('|'), cur = state.sort[s[0]] || {};
    state.sort[s[0]] = { col: s[1], dir: cur.col === s[1] ? -cur.dir : (s[1] === 'name' ? 1 : -1) };
    render();
  }
  else if (d.osort) {
    if (!ORDER_SORTS[d.osort]) return;
    var o = state.ord;
    o.dir = o.sort === d.osort && o.dir === 'desc' ? 'asc' : 'desc'; o.sort = d.osort; o.page = 0; loadOrders();
  }
  else if (d.day) zoom(d.day, d.day, 'orders');
  else if (d.go) go(d.go);
  else if (d.order) toggleOrder(d.order);
  else if (d.plot && e) {
    var hit = chartIndex(t, e); if (!hit) return;
    var b = hit.c.buckets[hit.i];
    if (b.first === state.from && b.last === state.to) zoom(b.first, b.last, 'orders'); else zoom(b.first, b.last);
  }
  else if (t.id === 'oPrev') { state.ord.page--; loadOrders(); }
  else if (t.id === 'oNext') { state.ord.page++; loadOrders(); }
  else if (t.id === 'fClear') { state.f = { m: '', t: '', c: '' }; state.ord.page = 0; render(); loadOrders(); }
  else if (t.id === 'back') goBack();
  else if (t.id === 'syncNow') syncNow();
}
function syncNow() {
  if (!provider.syncNow || state.syncing) return;
  state.syncing = true; state.syncMsg = ''; render();
  provider.syncNow().then(function (out) {
    var r = out.results || [], bad = r.filter(function (x) { return x.status !== 'ok'; }).length;
    state.syncMsg = !r.length ? (out.note || 'Nothing to sync.') : bad ? bad + ' of ' + r.length + ' sheets had a problem; see the Status column.' : 'Synced ' + r.length + (r.length === 1 ? ' sheet.' : ' sheets.');
  }).catch(function (e) { state.syncMsg = 'Sync failed: ' + e.message; })
    .then(function () { return provider.sync(); })
    .then(function (s) { state.sync = s || []; state.syncing = false; if (state.data) load(); });
}
var CLICKABLE = 'button, tr.click, [data-filter], [data-sort], [data-osort], [data-day], [data-go], svg[data-plot]';
document.addEventListener('click', function (e) {
  var t = e.target.closest(CLICKABLE); if (t && !t.disabled) act(t, e);
});
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  var t = e.target;
  if (t.matches && t.matches('tr.click, [data-filter], [data-sort], [data-osort], [data-day], [data-go]') && t.tagName !== 'BUTTON') { e.preventDefault(); act(t, null); }
});
document.addEventListener('mousemove', function (e) {
  var svg = e.target.closest && e.target.closest('svg[data-plot]');
  if (svg) chartHover(svg, e);
});
document.addEventListener('mouseout', function (e) {
  var svg = e.target.closest && e.target.closest('svg[data-plot]');
  if (svg && !(e.relatedTarget && svg.contains(e.relatedTarget))) {
    svg.parentNode.querySelector('.tip').hidden = true; svg.querySelector('.hl').setAttribute('visibility', 'hidden');
  }
});
function toggleOrder(raw) {
  var o = state.ord, id = +raw;
  o.open = o.open === id ? null : id;
  renderOrders();
  if (o.open && !o.lines[id]) provider.lines(id).then(function (ls) { o.lines[id] = ls || []; if (state.tab === 'orders') renderOrders(); })
    .catch(function (e) { setStatus('Could not load the order lines: ' + e.message); });
}
document.addEventListener('change', function (e) {
  var id = e.target.id, v = e.target.value;
  if (id === 'from' || id === 'to') {
    var f = $('from').value, t = $('to').value;
    if (!f || !t || f > t) return;
    state.stack = []; state.preset = ''; state.from = f; state.to = t; load();
  }
  else if (id === 'fM') { state.f.m = v; state.ord.page = 0; render(); loadOrders(); }
  else if (id === 'fT') { state.f.t = v; state.ord.page = 0; render(); loadOrders(); }
  else if (id === 'fC') { state.f.c = v; render(); }
  else if (id === 'oQ') { state.ord.q = v.trim(); state.ord.page = 0; loadOrders(); }
});
window.addEventListener('hashchange', function () {
  if ($('app').hidden) return;
  state.tab = (location.hash || '#overview').slice(1); render();
});
/* Signed-in pages pick up new data by themselves every 5 minutes (not while reading the orders list). */
setInterval(function () {
  if (state.mode === 'live' && state.data && !$('app').hidden && !document.hidden && state.tab !== 'orders') load();
}, 5 * 60 * 1000);
var resizeTimer;
window.addEventListener('resize', function () {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function () { if (!$('app').hidden && state.data) render(); }, 150);
});
$('signinForm').addEventListener('submit', function (e) {
  e.preventDefault();
  if (!sb) return showSignin();
  $('siMsg').textContent = 'Signing in…';
  sb.auth.signInWithPassword({ email: $('siEmail').value.trim(), password: $('siPass').value }).then(function (res) {
    if (res.error) { $('siMsg').textContent = 'Sign-in failed: ' + res.error.message; return; }
    $('siPass').value = '';
    start(sbProvider(), res.data.user.email, 'live');
  });
});
$('demoBtn').addEventListener('click', function () {
  try { sessionStorage.setItem('pl-demo', '1'); } catch (e) {}
  start(demoProvider(), 'Demo, invented numbers', 'demo');
});
$('signOut').addEventListener('click', function () {
  try { sessionStorage.removeItem('pl-demo'); } catch (e) {}
  var done = function () { state.data = null; $('view').innerHTML = ''; showSignin(); };
  if (state.mode === 'live' && sb) sb.auth.signOut().then(done, done); else done();
});

/* ---------- boot ---------- */
(function boot() {
  if (CFG.SUPABASE_URL && CFG.SUPABASE_PUBLISHABLE_KEY && window.supabase) {
    try { sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_PUBLISHABLE_KEY); } catch (e) { sb = null; }
  }
  var demo = false;
  try { demo = sessionStorage.getItem('pl-demo') === '1'; } catch (e) {}
  if (demo) return start(demoProvider(), 'Demo, invented numbers', 'demo');
  if (!sb) return showSignin();
  sb.auth.getSession().then(function (res) {
    var s = res.data && res.data.session;
    if (s) start(sbProvider(), s.user.email, 'live'); else showSignin();
  }, function () { showSignin(); });
})();

})();
