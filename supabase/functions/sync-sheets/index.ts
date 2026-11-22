// sync-sheets: copies Google Sheet tabs into the database.
//
// Called every 15 minutes by the database scheduler (see the sheet_sync migration).
// For each enabled row in sheet_sources it reads the tab through the Google Sheets API
// (read-only) and replaces that tab's rows in sheet_rows.
//
// Needs one secret, set in Supabase and never committed:
//   GOOGLE_SERVICE_ACCOUNT = the full JSON key file of the Google service account
// Each sheet must be shared as Viewer with that service account's email address.

import { createClient } from "jsr:@supabase/supabase-js@2";

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// The key may be stored as the JSON file's text, or as that text in base64 (one safe line).
function readKey(raw: string) {
  const t = raw.trim();
  return JSON.parse(t.startsWith("{") ? t : new TextDecoder().decode(Uint8Array.from(atob(t), (c) => c.charCodeAt(0))));
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
  if (/not supported for this document/i.test(why)) {
    return "This file is an Excel file stored in Google Drive, not a Google Sheet, so it cannot be read live. Open it, choose File > Save as Google Sheets, share the new copy with the robot and use its link.";
  }
  if (status === 403 || status === 404) {
    return "Google would not open the sheet. Check it is shared with the robot's email as Viewer and that the link and tab are right. (" + why + ")";
  }
  return "Google Sheets error: " + why;
}

function b64url(input: string | ArrayBuffer) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Swap the service account key for a short-lived, read-only Google access token.
async function googleToken(sa: { client_email: string; private_key: string }) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
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

type Source = { id: number; name: string; spreadsheet_id: string; tab: string; header_row: number };

// Reads one tab and turns it into [{ row_no, data: { "Column name": value } }].
async function readTab(token: string, s: Source) {
  const base = "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(s.spreadsheet_id);
  const auth = { headers: { Authorization: "Bearer " + token } };
  // The tab can be given by name, or as "gid:123" (the number after gid= in the sheet's address).
  let tab = s.tab;
  const gid = /^gid:(\d+)$/.exec(s.tab.trim());
  if (gid) {
    const mres = await fetch(base + "?fields=sheets.properties(sheetId,title)", auth);
    const meta = await mres.json();
    if (!mres.ok) throw new Error(googleProblem(mres.status, meta?.error?.message || String(mres.status)));
    const hit = (meta.sheets || []).find((x: { properties: { sheetId: number } }) => String(x.properties.sheetId) === gid[1]);
    if (!hit) throw new Error("No tab with that gid was found in the sheet.");
    tab = hit.properties.title;
  }
  const url = base + "/values/" + encodeURIComponent("'" + tab.replace(/'/g, "''") + "'") +
    "?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING";
  const res = await fetch(url, auth);
  const out = await res.json();
  if (!res.ok) throw new Error(googleProblem(res.status, out?.error?.message || String(res.status)));
  const values: unknown[][] = out.values || [];
  const head = values[s.header_row - 1] || [];
  const seen: Record<string, number> = {};
  const names = head.map((h, i) => {
    let n = String(h ?? "").trim() || "col_" + (i + 1);
    if (seen[n]) n = n + "_" + (++seen[n]); else seen[n] = 1;
    return n;
  });
  const rows: { row_no: number; data: Record<string, unknown> }[] = [];
  for (let i = s.header_row; i < values.length; i++) {
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

Deno.serve(async (req) => {
  // Health check: says only whether the Google key has been set.
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, google_key_set: !!Deno.env.get("GOOGLE_SERVICE_ACCOUNT") });

  // Two callers are allowed: the database scheduler (secret header) or a signed-in dashboard user.
  const { data: bySecret, error: authErr } = await db.rpc("check_sync_secret", { p: req.headers.get("x-sync-secret") ?? "" });
  if (authErr) return json({ error: "could not check the caller" }, 500);
  if (!bySecret && !(await isDashboardUser(req))) return json({ error: "not allowed" }, 401);

  const { data: sources, error } = await db.from("sheet_sources")
    .select("id, name, spreadsheet_id, tab, header_row").eq("enabled", true).order("id");
  if (error) return json({ error: error.message }, 500);
  if (!sources || !sources.length) return json({ ok: true, synced: 0, note: "no sheets listed yet" });

  let token = "";
  let setupError = "";
  try {
    const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT");
    if (!raw) throw new Error("The Google service account key has not been set in Supabase yet.");
    token = await googleToken(readKey(raw));
  } catch (e) {
    setupError = (e as Error).message;
  }

  const results = [];
  for (const s of sources as Source[]) {
    const started = new Date().toISOString();
    try {
      if (setupError) throw new Error(setupError);
      const rows = await readTab(token, s);
      const { data: n, error: writeErr } = await db.rpc("sheet_replace_rows", { p_source: s.id, p_rows: rows });
      if (writeErr) throw new Error(writeErr.message);
      await log(s.id, started, "ok", n as number, null);
      results.push({ name: s.name, status: "ok", rows: n });
    } catch (e) {
      const message = (e as Error).message.slice(0, 500);
      await log(s.id, started, "error", null, message);
      results.push({ name: s.name, status: "error", message });
    }
  }
  return json({ ok: true, synced: results.filter((r) => r.status === "ok").length, results });
});
