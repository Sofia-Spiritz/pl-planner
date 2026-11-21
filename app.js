/* P&L Planner dashboard.
   One page, hash-routed tabs. Reads from Supabase when signed in (sql/001_schema.sql),
   or from invented in-browser numbers in demo mode. Both go through the same three calls:
     provider.data(from, to)   -> { facts, orders, marketing, opex, meta }
     provider.orders(filter)   -> { rows, count }
     provider.lines(orderId)   -> [ line, ... ]
   All percentages are of net revenue (revenue after tax). */
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
  ['overview', 'Overview'], ['markets', 'By market'], ['threepl', 'By 3PL'], ['collections', 'By collection'],
  ['orders', 'Orders'], ['costs', 'Costs'], ['marketing', 'Marketing & OPEX'], ['notes', 'Data notes']
];
var PRESETS = [
  ['week', 'This week'], ['4w', 'Last 4 weeks'], ['month', 'This month'],
  ['lastmonth', 'Last month'], ['90d', 'Last 90 days'], ['ytd', 'Year to date']
];

var state = {
  tab: 'overview', preset: '4w', from: '', to: '', gran: 'day',
  data: null, hidden: {}, who: '', mode: '',
  ord: { page: 0, market: '', threepl: '', q: '', open: null, rows: [], count: 0, lines: {}, loading: false }
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
      }).reverse();
      return Promise.resolve({ count: rows.length, rows: rows.slice(q.page * PAGE, q.page * PAGE + PAGE).map(orderRow) });
    },
    lines: function (id) {
      var o = orders.filter(function (x) { return x.id === id; })[0];
      return Promise.resolve(o ? o.lines : []);
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
        .order('order_date', { ascending: false }).order('order_id', { ascending: false })
        .range(q.page * PAGE, q.page * PAGE + PAGE - 1);
      if (q.market) x = x.eq('market', q.market);
      if (q.threepl) x = x.ilike('threepls', '%' + q.threepl + '%');
      if (q.q) x = x.ilike('order_name', '%' + q.q.replace(/[%_,()]/g, '') + '%');
      return x.then(function (res) { check(res); return { rows: res.data, count: res.count || 0 }; });
    },
    lines: function (id) {
      return sb.from('order_lines').select('*, skus(name, collection)').eq('order_id', id).order('id')
        .then(function (res) { return check(res).data; });
    }
  };
}

/* ---------- P&L maths ---------- */
var ZERO = ['o', 'u', 'rev', 'tax', 'cogs', 'cogs_e', 'pp', 'pp_e', 'ship', 'ship_e', 'fee', 'fee_e'];
function blank() { var z = {}; ZERO.forEach(function (k) { z[k] = 0; }); return z; }
function addFact(z, r) { ZERO.forEach(function (k) { z[k] += +r[k] || 0; }); }

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
function period(from, to) {
  var z = blank(), orders = 0, mkt = 0;
  state.data.facts.forEach(function (r) { if (r.d >= from && r.d <= to) addFact(z, r); });
  state.data.orders.forEach(function (r) { if (r.d >= from && r.d <= to) orders += +r.o; });
  state.data.marketing.forEach(function (r) { if (r.d >= from && r.d <= to) mkt += +r.s; });
  return finish(z, orders, mkt, opexFor(from, to).total);
}
function prevRange() {
  var len = daysBetween(state.from, state.to), pto = addDays(state.from, -1);
  return { from: addDays(pto, -(len - 1)), to: pto };
}
/* Groups the current period by market (m), 3PL (t) or collection (c). */
function byDim(key) {
  var g = {}, ord = {}, mk = {}, from = state.from, to = state.to, totalNet = 0, totalMkt = 0;
  state.data.facts.forEach(function (r) {
    if (r.d < from || r.d > to) return;
    addFact(g[r[key]] = g[r[key]] || blank(), r);
    if (key === 'c') ord[r.c] = (ord[r.c] || 0) + (+r.o);
    totalNet += (+r.rev) - (+r.tax);
  });
  if (key !== 'c') state.data.orders.forEach(function (r) { if (r.d >= from && r.d <= to) ord[r[key]] = (ord[r[key]] || 0) + (+r.o); });
  state.data.marketing.forEach(function (r) {
    if (r.d < from || r.d > to) return;
    totalMkt += +r.s; mk[r.m] = (mk[r.m] || 0) + (+r.s);
  });
  return Object.keys(g).map(function (name) {
    var z = g[name], net = z.rev - z.tax;
    var mkt = key === 'm' ? (mk[name] || 0) : (totalNet ? totalMkt * net / totalNet : 0);
    z = finish(z, ord[name] || 0, mkt, 0); z.name = name; return z;
  }).sort(function (a, b) { return b.net - a.net; });
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
    if (!map[b]) { map[b] = { key: b, first: d, last: d, z: blank(), mkt: 0, orders: 0 }; keys.push(b); }
    map[b].last = d;
  }
  state.data.facts.forEach(function (r) { if (r.d >= state.from && r.d <= state.to) addFact(map[bucketOf(r.d)].z, r); });
  state.data.orders.forEach(function (r) { if (r.d >= state.from && r.d <= state.to) map[bucketOf(r.d)].orders += +r.o; });
  state.data.marketing.forEach(function (r) { if (r.d >= state.from && r.d <= state.to) map[bucketOf(r.d)].mkt += +r.s; });
  return keys.map(function (k) {
    var x = map[k], z = finish(x.z, x.orders, x.mkt, opexFor(x.first, x.last).total);
    z.label = state.gran === 'month' ? new Date(ms(k)).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }) : fmtDay(k);
    z.key = k; return z;
  });
}
function nameOf(list, code) {
  var hit = (state.data.meta[list] || []).filter(function (x) { return x.code === code; })[0];
  return hit ? hit.name : code;
}

/* ---------- small render pieces ---------- */
function delta(cur, prev, neutral) {
  if (!prev) return '<span class="muted">no earlier period</span>';
  var ch = (cur - prev) / Math.abs(prev) * 100;
  var cls = neutral ? 'muted' : (ch >= 0 ? 'up' : 'down');
  return '<span class="' + cls + '">' + (ch >= 0 ? '▲ ' : '▼ ') + Math.abs(ch).toFixed(1) + '%</span> <span class="muted">vs previous</span>';
}
function kpi(label, value, sub) {
  return '<div class="kpi"><div class="k">' + esc(label) + '</div><div class="v">' + value + '</div><div class="s">' + sub + '</div></div>';
}
function hbar(label, parts, total, valueText) {
  var fills = parts.map(function (p) {
    return '<span class="fill" style="width:' + (total ? Math.max(0, p[0]) / total * 100 : 0).toFixed(2) + '%;background:' + cssVar(p[1]) + '"></span>';
  }).join('');
  return '<div class="hbar"><span>' + esc(label) + '</span><span class="track">' + fills + '</span><span class="val">' + valueText + '</span></div>';
}
function granPicker() {
  return '<div class="seg">' + [['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(function (g) {
    return '<button type="button" data-gran="' + g[0] + '" class="' + (state.gran === g[0] ? 'on' : '') + '">' + g[1] + '</button>';
  }).join('') + '</div>';
}

/* Bars + lines chart in SVG with a clickable legend. */
function drawChart(hostId, labels, list, fmt) {
  var host = $(hostId); if (!host) return;
  var hid = state.hidden[hostId] = state.hidden[hostId] || {};
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
  vis.forEach(function (s) {
    if (s.type === 'bar') {
      s.values.forEach(function (v, i) {
        var y0 = y(0), y1 = y(v);
        out += '<rect x="' + (L + i * bw + bw * .15) + '" width="' + Math.max(1, bw * .7) + '" y="' + Math.min(y0, y1) + '" height="' + Math.abs(y1 - y0) +
               '" fill="' + cssVar(s.color) + '" opacity=".85"><title>' + esc(labels[i] + ' · ' + s.name + ': ' + fmt(v)) + '</title></rect>';
      });
    } else {
      out += '<polyline fill="none" stroke="' + cssVar(s.color) + '" stroke-width="2" points="' +
        s.values.map(function (v, i) { return (L + i * bw + bw / 2) + ',' + y(v); }).join(' ') + '"/>';
      s.values.forEach(function (v, i) {
        out += '<circle cx="' + (L + i * bw + bw / 2) + '" cy="' + y(v) + '" r="' + (n > 45 ? 4 : 3) + '" fill="' + cssVar(s.color) +
               '" opacity="' + (n > 45 ? 0 : 1) + '"><title>' + esc(labels[i] + ' · ' + s.name + ': ' + fmt(v)) + '</title></circle>';
      });
    }
  });
  host.innerHTML =
    '<div class="legend">' + list.map(function (s) {
      return '<button type="button" data-chart="' + hostId + '" data-series="' + esc(s.name) + '" class="' + (hid[s.name] ? 'off' : '') +
             '" aria-pressed="' + (!hid[s.name]) + '"><i style="background:' + cssVar(s.color) + '"></i>' + esc(s.name) + '</button>';
    }).join('') + '</div>' +
    '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Chart">' + out + '</svg>';
}

/* ---------- tabs ---------- */
function renderOverview() {
  var cur = period(state.from, state.to), pr = prevRange(), prev = period(pr.from, pr.to);
  var actualShare = cur.costs ? (cur.costs - cur.est) / cur.costs : 0;
  var html = '<div class="stack"><div class="kpis">' +
    kpi('Net revenue', money(cur.net), delta(cur.net, prev.net)) +
    kpi('Gross profit', money(cur.gp), pct(cur.gp, cur.net) + ' margin · ' + delta(cur.gp, prev.gp)) +
    kpi('Contribution', money(cur.con), pct(cur.con, cur.net) + ' · ' + delta(cur.con, prev.con)) +
    kpi('Net profit', money(cur.np), pct(cur.np, cur.net) + ' · ' + delta(cur.np, prev.np)) +
    kpi('Orders', num(cur.orders), delta(cur.orders, prev.orders)) +
    kpi('Net revenue per order', cur.orders ? money2(cur.net / cur.orders) : '–', delta(cur.orders ? cur.net / cur.orders : 0, prev.orders ? prev.net / prev.orders : 0)) +
    kpi('Costs on actuals', (actualShare * 100).toFixed(0) + '%', 'the rest is estimated') +
    '</div>';

  var rows = [
    ['Revenue (after discounts and refunds)', cur.rev, prev.rev, '', ''],
    ['Tax by market', -cur.tax, -prev.tax, 'sub', ''],
    ['Net revenue', cur.net, prev.net, 'total', ''],
    ['COGS (FIFO, landed)', -cur.cogs, -prev.cogs, 'sub', '--c-cogs'],
    ['Pick & pack', -cur.pp, -prev.pp, 'sub', '--c-pp'],
    ['Shipping', -cur.ship, -prev.ship, 'sub', '--c-ship'],
    ['Payment fees', -cur.fee, -prev.fee, 'sub', '--c-fee'],
    ['Gross profit', cur.gp, prev.gp, 'total', ''],
    ['Marketing', -cur.mkt, -prev.mkt, 'sub', '--c-mkt'],
    ['Contribution', cur.con, prev.con, 'total', ''],
    ['OPEX', -cur.opex, -prev.opex, 'sub', '--c-opex'],
    ['Net profit', cur.np, prev.np, 'total', '']
  ];
  html += '<div class="grid g2"><div class="panel"><div class="panel-head"><h3>P&amp;L ladder</h3><span class="small muted">% of net revenue</span></div><div class="scroll"><table><thead><tr><th>Line</th><th>Amount</th><th>%</th><th>Previous</th><th>Prev %</th></tr></thead><tbody>' +
    rows.map(function (r) {
      return '<tr class="' + r[3] + '"><td>' + (r[4] ? '<i class="dot" style="background:' + cssVar(r[4]) + '"></i>' : '') + esc(r[0]) + '</td><td>' + money(r[1]) +
             '</td><td class="pct">' + pct(Math.abs(r[1]), cur.net) + '</td><td>' + money(r[2]) + '</td><td class="pct">' + pct(Math.abs(r[2]), prev.net) + '</td></tr>';
    }).join('') + '</tbody></table></div></div>';

  var parts = COSTS.map(function (c) { return [c.n, cur[c.k], c.c]; }).concat([['Marketing', cur.mkt, '--c-mkt'], ['OPEX', cur.opex, '--c-opex']]);
  var biggest = Math.max.apply(null, parts.map(function (p) { return p[1]; }).concat([1]));
  html += '<div class="panel"><div class="panel-head"><h3>Where each ' + esc(CUR) + '1 of net revenue goes</h3></div>' +
    parts.map(function (p) { return hbar(p[0], [[p[1], p[2]]], biggest, pct(p[1], cur.net)); }).join('') +
    hbar('Net profit', [[cur.np, '--c-np']], biggest, pct(cur.np, cur.net)) +
    '<p class="note">Bars are sized against the largest cost. The figure is each line as a share of net revenue.</p></div></div>';

  html += '<div class="panel"><div class="panel-head"><h3>Revenue and profit over time</h3>' + granPicker() + '</div><div id="chMain"></div></div>';
  html += '<div class="panel"><div class="panel-head"><h3>Daily net revenue</h3><span class="small muted">darker = lower, brighter = higher; hover a square for the figure</span></div><div id="heat" class="heat"></div></div></div>';
  $('view').innerHTML = html;

  var s = series();
  drawChart('chMain', s.map(function (x) { return x.label; }), [
    { name: 'Net revenue', type: 'bar', color: '--c-rev', values: s.map(function (x) { return x.net; }) },
    { name: 'Gross profit', type: 'line', color: '--c-gp', values: s.map(function (x) { return x.gp; }) },
    { name: 'Contribution', type: 'line', color: '--c-con', values: s.map(function (x) { return x.con; }) },
    { name: 'Net profit', type: 'line', color: '--c-np', values: s.map(function (x) { return x.np; }) }
  ], money);

  var daily = {}, max = 0, cells = '', d;
  state.data.facts.forEach(function (r) { if (r.d >= state.from && r.d <= state.to) daily[r.d] = (daily[r.d] || 0) + (+r.rev) - (+r.tax); });
  Object.keys(daily).forEach(function (k) { if (daily[k] > max) max = daily[k]; });
  var pad = (new Date(ms(state.from)).getUTCDay() + 6) % 7;
  for (var i = 0; i < pad; i++) cells += '<i style="visibility:hidden"></i>';
  for (d = state.from; d <= state.to; d = addDays(d, 1)) {
    var v = daily[d] || 0;
    cells += '<i title="' + esc(fmtDay(d, true) + ': ' + money(v)) + '" style="background:color-mix(in srgb, var(--c-gp) ' + (max ? Math.round(12 + 88 * v / max) : 0) + '%, var(--panel2))"></i>';
  }
  $('heat').innerHTML = cells;
}

function renderDim(key, title, list) {
  var rows = byDim(key), tot = period(state.from, state.to);
  var label = function (r) { return list ? nameOf(list, r.name) : r.name; };
  var line = function (name, r, cls) {
    return '<tr class="' + cls + '"><td>' + esc(name) + '</td><td>' + num(r.orders) + '</td><td>' + money(r.net) + '</td><td class="pct">' + pct(r.net, tot.net) + '</td>' +
      COSTS.map(function (c) { return '<td class="pct">' + pct(r[c.k], r.net) + '</td>'; }).join('') +
      '<td>' + money(r.gp) + '</td><td class="pct">' + pct(r.gp, r.net) + '</td><td>' + money(r.mkt) + '</td><td>' + money(r.con) + '</td><td class="pct">' + pct(r.con, r.net) + '</td></tr>';
  };
  var max = Math.max.apply(null, rows.map(function (r) { return r.net; }).concat([1]));
  var html = '<div class="stack"><div class="panel"><div class="panel-head"><h3>Net revenue and what is left after order costs, ' + esc(title) + '</h3>' +
    '<span class="legend"><button type="button" disabled><i style="background:var(--c-gp)"></i>Gross profit</button><button type="button" disabled><i style="background:var(--c-rev)"></i>Order costs</button></span></div>' +
    rows.map(function (r) { return hbar(label(r), [[r.gp, '--c-gp'], [r.net - Math.max(0, r.gp), '--c-rev']], max, money(r.net)); }).join('') + '</div>' +
    '<div class="panel"><div class="panel-head"><h3>P&amp;L ' + esc(title) + '</h3><span class="small muted">cost columns are % of that row’s net revenue</span></div><div class="scroll"><table><thead><tr><th>' +
    esc(title.replace(/^by /, '')) + '</th><th>Orders</th><th>Net revenue</th><th>Share</th><th>COGS</th><th>Pick &amp; pack</th><th>Shipping</th><th>Pay fees</th><th>Gross profit</th><th>GP %</th><th>Marketing</th><th>Contribution</th><th>Contr %</th></tr></thead><tbody>' +
    rows.map(function (r) { return line(label(r), r, ''); }).join('') + line('Total', tot, 'total') + '</tbody></table></div>' +
    '<p class="note">' + (key === 'm'
      ? 'Marketing is the actual ad spend recorded against each market.'
      : 'Marketing is not recorded ' + esc(title) + ', so it is shared out by net revenue. OPEX is left out of this view.') +
    (key === 'c' ? ' Orders counts orders that contain the collection, so an order with two collections appears in both rows.' : '') + '</p></div></div>';
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
  drawChart('chCost', s.map(function (x) { return x.label; }), COSTS.map(function (c) {
    return { name: c.n, type: 'line', color: c.c, values: s.map(function (x) { return x.net ? x[c.k] / x.net * 100 : 0; }) };
  }), function (v) { return v.toFixed(1) + '%'; });
}

function renderMarketing() {
  var cur = period(state.from, state.to), plat = {}, ox = opexFor(state.from, state.to);
  state.data.marketing.forEach(function (r) { if (r.d >= state.from && r.d <= state.to) plat[r.p] = (plat[r.p] || 0) + (+r.s); });
  var pk = Object.keys(plat).sort(function (a, b) { return plat[b] - plat[a]; });
  var mrows = byDim('m');
  var html = '<div class="stack"><div class="kpis">' +
    kpi('Marketing spend', money(cur.mkt), pct(cur.mkt, cur.net) + ' of net revenue') +
    kpi('Net revenue per ' + CUR + '1 of spend', cur.mkt ? (cur.net / cur.mkt).toFixed(2) : '–', 'net revenue ÷ marketing') +
    kpi('Contribution', money(cur.con), pct(cur.con, cur.net) + ' of net revenue') +
    kpi('OPEX', money(cur.opex), pct(cur.opex, cur.net) + ' of net revenue') +
    kpi('Net profit', money(cur.np), pct(cur.np, cur.net) + ' of net revenue') + '</div>';
  html += '<div class="grid g2"><div class="panel"><div class="panel-head"><h3>Spend by platform</h3></div>' +
    (pk.length ? pk.map(function (p) { return hbar(p, [[plat[p], '--c-mkt']], plat[pk[0]], money(plat[p])); }).join('') : '<p class="muted">No ad spend in this period.</p>') + '</div>';
  html += '<div class="panel"><div class="panel-head"><h3>OPEX in this period</h3><span class="small muted">monthly figures, shared by day</span></div><div class="scroll"><table><thead><tr><th>Category</th><th>Amount</th><th>%</th></tr></thead><tbody>' +
    Object.keys(ox.by).sort(function (a, b) { return ox.by[b] - ox.by[a]; }).map(function (c) {
      return '<tr><td>' + esc(c) + '</td><td>' + money(ox.by[c]) + '</td><td class="pct">' + pct(ox.by[c], cur.net) + '</td></tr>';
    }).join('') + '<tr class="total"><td>Total</td><td>' + money(ox.total) + '</td><td class="pct">' + pct(ox.total, cur.net) + '</td></tr></tbody></table></div></div></div>';
  html += '<div class="panel"><div class="panel-head"><h3>Marketing by market</h3></div><div class="scroll"><table><thead><tr><th>Market</th><th>Spend</th><th>Net revenue</th><th>Spend %</th><th>Gross profit</th><th>Contribution</th><th>Contr %</th></tr></thead><tbody>' +
    mrows.map(function (r) {
      return '<tr><td>' + esc(nameOf('markets', r.name)) + '</td><td>' + money(r.mkt) + '</td><td>' + money(r.net) + '</td><td class="pct">' + pct(r.mkt, r.net) +
             '</td><td>' + money(r.gp) + '</td><td>' + money(r.con) + '</td><td class="pct">' + pct(r.con, r.net) + '</td></tr>';
    }).join('') + '</tbody></table></div></div></div>';
  $('view').innerHTML = html;
}

function renderOrders() {
  var o = state.ord, meta = state.data.meta;
  var opt = function (list, sel, all) {
    return '<option value="">' + all + '</option>' + (list || []).map(function (x) {
      return '<option value="' + esc(x.code) + '"' + (x.code === sel ? ' selected' : '') + '>' + esc(x.name) + '</option>';
    }).join('');
  };
  var body;
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
    '<select id="oMarket" aria-label="Market">' + opt(meta.markets, o.market, 'All markets') + '</select>' +
    '<select id="oTpl" aria-label="3PL">' + opt(meta.threepls, o.threepl, 'All 3PLs') + '</select>' +
    '<input id="oQ" type="search" placeholder="Order number" aria-label="Order number" value="' + esc(o.q) + '"></div></div>' +
    '<div class="scroll"><table><thead><tr><th>Order</th><th class="l">Date</th><th class="l">Market</th><th class="l">3PL</th><th>Units</th><th>Net revenue</th><th>COGS</th><th>Pick &amp; pack</th><th>Shipping</th><th>Pay fees</th><th>Gross profit</th><th class="l">Source</th></tr></thead><tbody>' +
    body + '</tbody></table></div><div class="pager"><span class="muted">' + num(o.count) + ' orders · page ' + (o.page + 1) + ' of ' + pages + '</span>' +
    '<button class="btn small" type="button" id="oPrev"' + (o.page ? '' : ' disabled') + '>Previous</button>' +
    '<button class="btn small" type="button" id="oNext"' + (o.page + 1 < pages ? '' : ' disabled') + '>Next</button></div>' +
    '<p class="note">Select an order to see each line and where every cost came from. Marketing and OPEX are not on individual orders.</p></div>';
}
function loadOrders() {
  var o = state.ord; o.loading = true; o.open = null;
  if (state.tab === 'orders') renderOrders();
  return provider.orders({ from: state.from, to: state.to, market: o.market, threepl: o.threepl, q: o.q, page: o.page })
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
    '<h3>Definitions</h3><ul>' +
    '<li><b>Revenue</b>: sales after discounts and refunds, tax still included.</li>' +
    '<li><b>Net revenue</b>: revenue minus the tax that belongs to the ship-to market. Every percentage on the dashboard is a share of net revenue.</li>' +
    '<li><b>Gross profit</b>: net revenue minus COGS, pick &amp; pack, shipping and payment fees. These four are stored on each order line.</li>' +
    '<li><b>Contribution</b>: gross profit minus marketing. Ad spend is recorded by day, market and platform.</li>' +
    '<li><b>Net profit</b>: contribution minus OPEX. OPEX is entered per month and shared evenly across the days of that month.</li>' +
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
  var pr = prevRange();
  $('rangeNote').textContent = daysBetween(state.from, state.to) + ' days, compared with ' + fmtDay(pr.from) + ' to ' + fmtDay(pr.to, true);
  if (!state.data) return;
  $('sampleBadge').hidden = !state.data.meta.sample;
  $('demoBadge').hidden = state.mode !== 'demo';
  if (state.tab === 'overview') renderOverview();
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
function load() {
  var pr = prevRange();
  setStatus('Loading…');
  state.ord.page = 0;
  return provider.data(pr.from, state.to).then(function (d) {
    d.facts = d.facts || []; d.orders = d.orders || []; d.marketing = d.marketing || []; d.opex = d.opex || []; d.meta = d.meta || {};
    state.data = d;
    setStatus(d.facts.length ? '' : 'No orders in this period. If the database is new, run sql/001_schema.sql and then sql/002_sample_data.sql in the Supabase SQL editor.');
    render();
    return loadOrders();
  }).catch(function (e) {
    setStatus('Could not load the data: ' + e.message + '. If the database has not been set up yet, run sql/001_schema.sql in the Supabase SQL editor.');
    render();
  });
}
function start(p, who, mode) {
  provider = p; state.who = who; state.mode = mode;
  $('signin').hidden = true; $('app').hidden = false;
  $('who').textContent = who;
  $('signOut').textContent = mode === 'demo' ? 'Leave demo' : 'Sign out';
  state.tab = (location.hash || '#overview').slice(1);
  applyPreset(state.preset);
  load();
}
function showSignin(msg) {
  $('app').hidden = true; $('signin').hidden = false;
  $('siMsg').textContent = msg || (sb ? '' : 'Sign-in is not available right now (the sign-in library did not load). The demo still works.');
}

/* ---------- events ---------- */
document.addEventListener('click', function (e) {
  var t = e.target.closest('button, tr.click'); if (!t) return;
  if (t.dataset.preset) { applyPreset(t.dataset.preset); load(); }
  else if (t.dataset.gran) { state.gran = t.dataset.gran; render(); }
  else if (t.dataset.chart) { var h = state.hidden[t.dataset.chart]; h[t.dataset.series] = !h[t.dataset.series]; render(); }
  else if (t.id === 'oPrev') { state.ord.page--; loadOrders(); }
  else if (t.id === 'oNext') { state.ord.page++; loadOrders(); }
  else if (t.dataset.order) toggleOrder(t.dataset.order);
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && e.target.matches && e.target.matches('tr.click')) toggleOrder(e.target.dataset.order);
});
function toggleOrder(raw) {
  var o = state.ord, id = +raw;
  o.open = o.open === id ? null : id;
  renderOrders();
  if (o.open && !o.lines[id]) provider.lines(id).then(function (ls) { o.lines[id] = ls || []; if (state.tab === 'orders') renderOrders(); })
    .catch(function (e) { setStatus('Could not load the order lines: ' + e.message); });
}
document.addEventListener('change', function (e) {
  var id = e.target.id;
  if (id === 'from' || id === 'to') {
    var f = $('from').value, t = $('to').value;
    if (!f || !t || f > t) return;
    state.preset = ''; state.from = f; state.to = t; load();
  } else if (id === 'oMarket') { state.ord.market = e.target.value; state.ord.page = 0; loadOrders(); }
  else if (id === 'oTpl') { state.ord.threepl = e.target.value; state.ord.page = 0; loadOrders(); }
  else if (id === 'oQ') { state.ord.q = e.target.value.trim(); state.ord.page = 0; loadOrders(); }
});
window.addEventListener('hashchange', function () {
  if ($('app').hidden) return;
  state.tab = (location.hash || '#overview').slice(1); render();
});
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
