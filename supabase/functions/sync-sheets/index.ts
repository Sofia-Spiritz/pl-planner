// sync-sheets: copies spreadsheet tabs from Google Drive into the database.
//
// Called every 15 minutes by the database scheduler, or by "Sync now" on the dashboard.
//   - For each folder in sheet_folders: every spreadsheet in it (shortcuts included) is read,
//     every tab, and each tab gets its own row in sheet_sources.
//   - For each hand-listed row in sheet_sources: that one file and tab is read.
// Google Sheets are read through the Sheets API; Excel workbooks are downloaded and opened here.
// Each tab's rows replace the previous copy in sheet_rows.
//
// Needs one secret, set in Supabase and never committed:
//   GOOGLE_SERVICE_ACCOUNT = the Google service account's JSON key (plain or base64)
// Folders and files must be shared as Viewer with the robot's email. A shortcut does not
// give access by itself: the file it points to must be shared too.

import { createClient } from "jsr:@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx@0.18.5";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// The dashboard (another web address) may call this function, so browsers need these headers.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
const SHORTCUT = "application/vnd.google-apps.shortcut";
const EXCEL_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.macroenabled.12",
];
const MAX_EXCEL_BYTES = 15 * 1024 * 1024;
const MAX_TABS = 40;

type DriveFile = { id: string; name: string; mimeType: string; size?: string };
type Tab = { tab: string; values: unknown[][] };
type Source = { id: number; name: string; spreadsheet_id: string | null; file_name: string | null; tab: string | null; header_row: number };
type Result = { name: string; status: "ok" | "error"; rows?: number; message?: string };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function b64url(input: string | ArrayBuffer) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// The key may be stored as the JSON file's text, or as that text in base64 (one safe line).
function readKey(raw: string) {
  const t = raw.trim();
  return JSON.parse(t.startsWith("{") ? t : new TextDecoder().decode(Uint8Array.from(atob(t), (c) => c.charCodeAt(0))));
}

// Swap the service account key for a short-lived, read-only Google access token.
async function googleToken(sa: { client_email: string; private_key: string }) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 600,
  }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: unsigned + "." + b64url(sig),
    }),
  });
  const out = await res.json();
  if (!res.ok || !out.access_token) throw new Error("Google sign-in failed: " + (out.error_description || out.error || res.status));
  return out.access_token as string;
}

// A signed-in dashboard user on the allowed list may also start a sync ("Sync now").
async function isDashboardUser(req: Request) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const { data, error } = await db.auth.getUser(token);
  const email = data?.user?.email;
  if (error || !email) return false;
  const { data: rows } = await db.from("dashboard_users").select("email");
  return (rows || []).some((r: { email: string }) => r.email.toLowerCase() === email.toLowerCase());
}

function googleProblem(status: number, why: string) {
  if (/has not been used in project|is disabled|accessNotConfigured/i.test(why)) {
    return "A Google connection (Drive or Sheets) is not switched on for the robot's Google Cloud project.";
  }
  if (status === 403 || status === 404) {
    return "Not shared with the robot. Share the file itself (not only a shortcut to it) with the robot's email as Viewer.";
  }
  return "Google error: " + why;
}

async function google(token: string, url: string) {
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) {
    let why = String(res.status);
    try { why = (await res.json())?.error?.message || why; } catch { /* not JSON */ }
    throw new Error(googleProblem(res.status, why));
  }
  return res;
}

// Every spreadsheet in a folder. Shortcuts are followed to the file they point to.
async function folderFiles(token: string, folderId: string) {
  const q = "'" + folderId.replace(/'/g, "\\'") + "' in parents and trashed = false";
  const res = await google(token, DRIVE + "?q=" + encodeURIComponent(q) +
    "&fields=files(id,name,mimeType,size,shortcutDetails)&pageSize=200&orderBy=name&supportsAllDrives=true&includeItemsFromAllDrives=true");
  const out: DriveFile[] = [];
  for (const f of ((await res.json()).files || [])) {
    if (f.mimeType === SHORTCUT && f.shortcutDetails) {
      out.push({ id: f.shortcutDetails.targetId, name: f.name, mimeType: f.shortcutDetails.targetMimeType });
    } else out.push(f);
  }
  return out.filter((f) => f.mimeType === GOOGLE_SHEET || EXCEL_TYPES.includes(f.mimeType));
}

// Finds a hand-listed file: by ID if we have one, otherwise by name among files the robot can see.
async function findFile(token: string, s: Source): Promise<DriveFile> {
  if (s.spreadsheet_id) {
    return await (await google(token, DRIVE + "/" + encodeURIComponent(s.spreadsheet_id) + "?fields=id,name,mimeType,size&supportsAllDrives=true")).json();
  }
  const name = (s.file_name || "").trim();
  if (!name) throw new Error("This source has neither a file ID nor a file name.");
  const types = [GOOGLE_SHEET, ...EXCEL_TYPES].map((t) => "mimeType = '" + t + "'").join(" or ");
  const q = "name = '" + name.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "' and trashed = false and (" + types + ")";
  const res = await google(token, DRIVE + "?q=" + encodeURIComponent(q) +
    "&fields=files(id,name,mimeType,size)&pageSize=5&supportsAllDrives=true&includeItemsFromAllDrives=true");
  const files = ((await res.json()).files || []) as DriveFile[];
  if (!files.length) throw new Error("No spreadsheet called \"" + name + "\" is shared with the robot.");
  if (files.length > 1) throw new Error("More than one spreadsheet called \"" + name + "\" is shared with the robot. Rename one, or list it by link.");
  await db.from("sheet_sources").update({ spreadsheet_id: files[0].id }).eq("id", s.id); // survive a later rename
  return files[0];
}

// Picks which tabs to read. want: "*" = all, null/"" = the first, "gid:123" or a name = that one.
function pickTabs(all: { title: string; gid?: string }[], want: string | null) {
  if (!all.length) throw new Error("The file has no tabs.");
  if (want === "*") return all.slice(0, MAX_TABS);
  const w = (want || "").trim();
  if (!w) return [all[0]];
  const gid = /^gid:(\d+)$/.exec(w);
  const hit = gid ? all.find((t) => t.gid === gid[1]) : all.find((t) => t.title.toLowerCase() === w.toLowerCase());
  if (hit) return [hit];
  if (gid && all[0].gid === undefined) return [all[0]]; // Excel files have no gid: fall back to the first tab
  throw new Error("No tab matching \"" + w + "\". Tabs found: " + all.map((t) => t.title).join(", "));
}

async function readFile(token: string, file: DriveFile, want: string | null): Promise<{ kind: string; tabs: Tab[] }> {
  if (file.mimeType === GOOGLE_SHEET) {
    const base = "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(file.id);
    const meta = await (await google(token, base + "?fields=sheets.properties(sheetId,title)")).json();
    const picked = pickTabs((meta.sheets || []).map((x: { properties: { sheetId: number; title: string } }) =>
      ({ title: x.properties.title, gid: String(x.properties.sheetId) })), want);
    const ranges = picked.map((t) => "ranges=" + encodeURIComponent("'" + t.title.replace(/'/g, "''") + "'")).join("&");
    const out = await (await google(token, base + "/values:batchGet?" + ranges +
      "&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING")).json();
    return { kind: "Google Sheet", tabs: picked.map((t, i) => ({ tab: t.title, values: out.valueRanges?.[i]?.values || [] })) };
  }
  if (EXCEL_TYPES.includes(file.mimeType)) {
    if (file.size && +file.size > MAX_EXCEL_BYTES) {
      throw new Error("The Excel file is too large to read live (" + Math.round(+file.size / 1048576) + " MB). Save it as a Google Sheet instead.");
    }
    const res = await google(token, DRIVE + "/" + encodeURIComponent(file.id) + "?alt=media&supportsAllDrives=true");
    const book = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: "array", cellDates: true });
    const picked = pickTabs((book.SheetNames || []).map((n: string) => ({ title: n })), want);
    return {
      kind: "Excel file",
      tabs: picked.map((t) => {
        const values = XLSX.utils.sheet_to_json(book.Sheets[t.title], { header: 1, raw: true, defval: null, blankrows: true }) as unknown[][];
        for (const row of values) {
          for (let i = 0; i < row.length; i++) {
            const v = row[i];
            if (v instanceof Date) { // store dates as plain text
              const iso = v.toISOString();
              row[i] = iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
            }
          }
        }
        return { tab: t.title, values };
      }),
    };
  }
  throw new Error("\"" + file.name + "\" is not a spreadsheet.");
}

// Turns a grid of cells into [{ row_no, data: { "Column name": value } }].
function toRows(values: unknown[][], headerRow: number) {
  const head = values[headerRow - 1] || [];
  const seen: Record<string, number> = {};
  const names = Array.from(head, (h, i) => {
    let n = String(h ?? "").trim() || "col_" + (i + 1);
    if (seen[n]) n = n + "_" + (++seen[n]); else seen[n] = 1;
    return n;
  });
  const rows: { row_no: number; data: Record<string, unknown> }[] = [];
  for (let i = headerRow; i < values.length; i++) {
    const v = values[i] || [];
    if (!v.some((c) => c !== "" && c != null)) continue; // skip empty rows
    const data: Record<string, unknown> = {};
    names.forEach((n, j) => { if (v[j] !== "" && v[j] != null) data[n] = v[j]; });
    rows.push({ row_no: i + 1, data });
  }
  return rows;
}

async function log(source_id: number, started: string, status: "ok" | "error", row_count: number | null, message: string | null) {
  await db.from("sheet_sync_log").insert({
    source_id, started_at: started, finished_at: new Date().toISOString(), status, row_count, message,
  });
}

async function store(sourceId: number, name: string, headerRow: number, t: Tab, kind: string, fileName: string, started: string, results: Result[]) {
  const { data: n, error } = await db.rpc("sheet_replace_rows", { p_source: sourceId, p_rows: toRows(t.values, headerRow) });
  if (error) throw new Error(error.message);
  await log(sourceId, started, "ok", n as number, kind + " \"" + fileName + "\", tab \"" + t.tab + "\"");
  results.push({ name, status: "ok", rows: n as number });
}

// The sheet_sources row for one tab of a folder file (made on first sight). tab null = the file itself,
// used only to report a file that could not be opened.
async function autoSource(folderId: number, file: DriveFile, tab: string | null) {
  let q = db.from("sheet_sources").select("id, name, header_row").eq("auto", true).eq("spreadsheet_id", file.id);
  q = tab === null ? q.is("tab", null) : q.eq("tab", tab);
  const { data: found } = await q.limit(1);
  if (found && found.length) return found[0] as { id: number; name: string; header_row: number };
  const base = tab === null ? file.name : file.name + " / " + tab;
  for (const name of [base, base + " (" + file.id.slice(0, 6) + ")"]) {
    const { data, error } = await db.from("sheet_sources")
      .insert({ name, spreadsheet_id: file.id, tab, header_row: 1, auto: true, folder_id: folderId })
      .select("id, name, header_row").single();
    if (!error && data) return data as { id: number; name: string; header_row: number };
  }
  throw new Error("Could not register \"" + base + "\" as a source.");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  // Health check: says only whether the Google key has been set.
  if (req.method === "GET") return json({ ok: true, google_key_set: !!Deno.env.get("GOOGLE_SERVICE_ACCOUNT") });

  // Two callers are allowed: the database scheduler (secret header) or a signed-in dashboard user.
  const { data: bySecret, error: authErr } = await db.rpc("check_sync_secret", { p: req.headers.get("x-sync-secret") ?? "" });
  if (authErr) return json({ error: "could not check the caller" }, 500);
  if (!bySecret && !(await isDashboardUser(req))) return json({ error: "not allowed" }, 401);

  const { data: folders } = await db.from("sheet_folders").select("id, name, folder_id").eq("enabled", true).order("id");
  const { data: sources, error } = await db.from("sheet_sources")
    .select("id, name, spreadsheet_id, file_name, tab, header_row").eq("enabled", true).eq("auto", false).order("id");
  if (error) return json({ error: error.message }, 500);
  if (!(folders || []).length && !(sources || []).length) return json({ ok: true, synced: 0, note: "no sheets listed yet" });

  const results: Result[] = [];
  let token = "";
  try {
    const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT");
    if (!raw) throw new Error("The Google service account key has not been set in Supabase yet.");
    token = await googleToken(readKey(raw));
  } catch (e) {
    console.log("sync-sheets setup problem " + (e as Error).message);
    return json({ ok: false, error: (e as Error).message }, 200);
  }

  // 1. Folders: every spreadsheet, every tab.
  for (const folder of (folders || []) as { id: number; name: string; folder_id: string }[]) {
    let files: DriveFile[] = [];
    try {
      files = await folderFiles(token, folder.folder_id);
      if (!files.length) results.push({ name: "Folder " + folder.name, status: "error", message: "No spreadsheets found. Check the folder is shared with the robot's email as Viewer." });
    } catch (e) {
      results.push({ name: "Folder " + folder.name, status: "error", message: (e as Error).message });
    }
    for (const file of files) {
      const started = new Date().toISOString();
      try {
        const read = await readFile(token, file, "*");
        for (const t of read.tabs) {
          const src = await autoSource(folder.id, file, t.tab);
          await store(src.id, src.name, src.header_row, t, read.kind, file.name, started, results);
        }
        await db.from("sheet_sources").delete().eq("auto", true).eq("spreadsheet_id", file.id).is("tab", null); // clear an old "could not open" entry
      } catch (e) {
        const message = (e as Error).message.slice(0, 500);
        try { const src = await autoSource(folder.id, file, null); await log(src.id, started, "error", null, message); } catch { /* reported below anyway */ }
        results.push({ name: file.name, status: "error", message });
      }
    }
  }

  // 2. Hand-listed files: one file, one tab each.
  for (const s of (sources || []) as Source[]) {
    const started = new Date().toISOString();
    try {
      const file = await findFile(token, s);
      const read = await readFile(token, file, s.tab);
      await store(s.id, s.name, s.header_row, read.tabs[0], read.kind, file.name, started, results);
    } catch (e) {
      const message = (e as Error).message.slice(0, 500);
      await log(s.id, started, "error", null, message);
      results.push({ name: s.name, status: "error", message });
    }
  }

  console.log("sync-sheets result " + JSON.stringify(results)); // names, statuses and messages only, no sheet data
  return json({ ok: true, synced: results.filter((r) => r.status === "ok").length, results });
});
