// STEP 2 of the sheet refresh. Run on the Google Sheets page that step 1 moved the tab to.
// Starts copying every listed spreadsheet, tab by tab, through Google's own CSV download
// address, slowly enough not to be throttled. It keeps running in the page; check on it
// with step 3. Read-only: nothing in any sheet is changed.
const list = JSON.parse(decodeURIComponent(location.hash.replace("#pick=", "")));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const unescapeJs = (s) => s
  .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\(.)/g, "$1");
const isPage = (t) => !t || t.startsWith("<!DOCTYPE") || t.startsWith("<html");
const J = window.__job = { done: false, total: list.length, sheets: [], funnel: null, failed: [], tabsDone: 0, started: Date.now() };

(async () => {
  for (const [id, name] of list) {
    const S = { sheet: name, exported_at: new Date().toISOString(), tabs: {} };
    try {
      const html = await (await fetch("/spreadsheets/d/" + id + "/htmlview")).text();
      let tabs = [...html.matchAll(/items\.push\(\{name: "((?:[^"\\]|\\.)*)"[^}]*?gid: "(\d+)"/g)].map((m) => ({ name: unescapeJs(m[1]), gid: m[2] }));
      if (!tabs.length) tabs = [{ name: "Sheet1", gid: "0" }];
      for (const t of tabs.slice(0, 24)) {
        let good = false;
        for (let attempt = 0; attempt < 4 && !good; attempt++) {
          await wait(2200 + attempt * 3000);
          try {
            const text = await (await fetch("/spreadsheets/d/" + id + "/export?format=csv&gid=" + t.gid)).text();
            if (!isPage(text)) { S.tabs[t.name] = text; good = true; }
          } catch (e) { /* try again */ }
        }
        if (!good) J.failed.push(name.slice(0, 40) + " / " + t.name);
        J.tabsDone++;
      }
    } catch (e) { J.failed.push(name.slice(0, 40) + " / ALL"); }
    J.sheets.push(S);

    // The Daily Funnel Sheet also feeds the Marketing funnel tab, which needs raw numbers.
    if (/daily funnel sheet/i.test(name)) {
      try {
        const F = { sheet: name, exported_at: new Date().toISOString(), tabs: {} };
        const fix = (v) => { const m = typeof v === "string" && /^Date\((\d+),(\d+),(\d+)/.exec(v); return m ? m[1] + "-" + String(+m[2] + 1).padStart(2, "0") + "-" + String(m[3]).padStart(2, "0") : v; };
        for (const tab of ["UK vs US Daily Data", "SKU Daily Data", "Monthly Market Data", "Monthly Data", "Monthly OPEX Breakdown"]) {
          await wait(1500);
          const text = await (await fetch("/spreadsheets/d/" + id + "/gviz/tq?tqx=out:json&sheet=" + encodeURIComponent(tab))).text();
          const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
          if (j.status === "error") throw new Error("funnel tab " + tab);
          F.tabs[tab] = { cols: j.table.cols.map((c) => c.label || c.id), rows: j.table.rows.map((r) => r.c.map((c) => (c == null ? null : { v: fix(c.v), f: c.f == null ? null : c.f }))) };
        }
        J.funnel = F;
      } catch (e) { J.failed.push("Daily Funnel raw numbers"); }
    }
  }
  J.done = true;
  J.finished = Date.now();
})();
"started copying " + list.length + " spreadsheets";
