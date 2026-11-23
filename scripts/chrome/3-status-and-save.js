// STEP 3 of the sheet refresh. Run on the same Google Sheets page, as often as needed.
// Reports progress. Once the copy has finished it saves ONE file to the Downloads folder
// (sofia-spritz-sheets-all.json) and says so. Only one save is attempted per page.
const J = window.__job;
let out;
if (!J) out = { error: "no copy is running in this tab; run steps 1 and 2 again" };
else {
  out = { done: J.done, sheets_done: J.sheets.length, of: J.total, tabs_done: J.tabsDone, failed: J.failed.length,
          minutes: Math.round((Date.now() - J.started) / 60000) };
  if (J.done && !J.saved) {
    const blob = new Blob([JSON.stringify({ sheets: J.sheets, funnel: J.funnel })], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sofia-spritz-sheets-all.json";
    document.body.appendChild(a); a.click(); a.remove();
    J.saved = true;
    out.saved = "sofia-spritz-sheets-all.json";
    out.bytes = blob.size;
    out.failed_list = J.failed.slice(0, 12);
  } else if (J.saved) out.saved = "already saved";
}
out;
