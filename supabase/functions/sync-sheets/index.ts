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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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
  const url = "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(s.spreadsheet_id) +
    "/values/" + encodeURIComponent("'" + s.tab.replace(/'/g, "''") + "'") +
    "?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING";
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  const out = await res.json();
  if (!res.ok) {
    const why = out?.error?.message || String(res.status);
    throw new Error(res.status === 403 || res.status === 404
      ? "Google would not open the sheet. Check it is shared with the service account and the ID and tab name are right. (" + why + ")"
      : "Google Sheets error: " + why);
  }
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
  if (req.method === "GET") return json({ ok: true, google_key_set: !!Deno.env.get("GOOGLE_SERVICE_ACCOUNT") });

  const { data: allowed, error: authErr } = await db.rpc("check_sync_secret", { p: req.headers.get("x-sync-secret") ?? "" });
  if (authErr) return json({ error: "could not check the caller" }, 500);
  if (!allowed) return json({ error: "not allowed" }, 401);

  const { data: sources, error } = await db.from("sheet_sources")
    .select("id, name, spreadsheet_id, tab, header_row").eq("enabled", true).order("id");
  if (error) return json({ error: error.message }, 500);
  if (!sources || !sources.length) return json({ ok: true, synced: 0, note: "no sheets listed yet" });

  let token = "";
  let setupError = "";
  try {
    const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT");
    if (!raw) throw new Error("The Google service account key has not been set in Supabase yet.");
    token = await googleToken(JSON.parse(raw));
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
