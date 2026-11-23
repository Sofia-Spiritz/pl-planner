// STEP 1 of the sheet refresh. Run on https://drive.google.com/drive/u/1/search?q=type:spreadsheet
// Lists every spreadsheet the signed-in Google account can see, then moves the tab to
// Google Sheets with that list in the address, ready for step 2. Read-only: nothing is opened or changed.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const seen = {};
const grab = () => {
  document.querySelectorAll("[data-id]").forEach((e) => {
    const id = e.getAttribute("data-id");
    if (!id || id.length < 25 || seen[id]) return;
    const label = (e.getAttribute("aria-label") || e.innerText || "").split("\n")[0].trim();
    if (label) seen[id] = label.replace(/\s+(Google Sheets|Shared|Spreadsheet).*$/i, "").trim();
  });
};
const scroller = [...document.querySelectorAll("*")]
  .filter((e) => e.scrollHeight > e.clientHeight + 200 && getComputedStyle(e).overflowY != "visible")
  .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
for (let i = 0; i < 16; i++) { grab(); if (scroller) scroller.scrollTop = scroller.scrollHeight; await wait(700); }
grab();
const account = (document.querySelector('a[aria-label*="Google Account"]') || {}).ariaLabel || "";
// The caller sets these two in the page first (they are kept out of this public file):
//   window.__expectAccount = the Google account that must be signed in
//   window.__skipNames     = text; any spreadsheet whose name contains it is never copied
const expect = String(window.__expectAccount || "").toLowerCase();
const skip = String(window.__skipNames || "").toLowerCase();
const list = Object.entries(seen).filter(([, name]) => !skip || !name.toLowerCase().includes(skip));
const result = { account: account.replace(/\s+/g, " "), found: Object.keys(seen).length, to_copy: list.length };
if (expect && skip && account.toLowerCase().includes(expect) && list.length) {
  location.href = "https://docs.google.com/spreadsheets/u/1/#pick=" + encodeURIComponent(JSON.stringify(list));
  result.next = "moved to Google Sheets; run step 2 there";
} else {
  result.next = "STOP: wrong Google account, settings not given, or nothing found";
}
result;
