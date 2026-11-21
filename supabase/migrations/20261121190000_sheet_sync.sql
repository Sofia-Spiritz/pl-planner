-- P&L Planner: receiving side for live Google Sheets.
--
-- How it works
--   1. sheet_sources lists the sheet tabs to read (one row per tab).
--   2. Every 15 minutes the database calls the "sync-sheets" function.
--   3. The function reads each tab through the Google Sheets API and replaces that
--      tab's rows in sheet_rows (one row per sheet row, as-is, in a JSON column).
--   4. sheet_sync_log records every run, so the dashboard can show "last updated".
--
-- Turning raw sheet rows into orders, costs and so on is a later step, one view or
-- function per sheet, once the real layouts are known.
--
-- Security: none of these tables can be read from the web page. The dashboard only
-- gets a summary through sync_status(), and only for users on the allowed list.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create table if not exists public.sheet_sources (
  id             bigint generated always as identity primary key,
  name           text    not null unique,          -- what people call it, e.g. 'Daily funnel'
  spreadsheet_id text    not null,                 -- the long ID in the sheet's web address
  tab            text    not null,                 -- tab name, exactly as in the sheet
  header_row     int     not null default 1,       -- which row holds the column names
  enabled        boolean not null default true,
  notes          text
);

create table if not exists public.sheet_rows (
  source_id bigint not null references public.sheet_sources(id) on delete cascade,
  row_no    int    not null,                       -- row number in the sheet
  data      jsonb  not null,                       -- { "Column name": value, ... }
  synced_at timestamptz not null default now(),
  primary key (source_id, row_no)
);

create table if not exists public.sheet_sync_log (
  id          bigint generated always as identity primary key,
  source_id   bigint references public.sheet_sources(id) on delete cascade,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null check (status in ('ok', 'error')),
  row_count   int,
  message     text
);
create index if not exists sheet_sync_log_source_idx on public.sheet_sync_log (source_id, started_at desc);

do $$
declare t text;
begin
  foreach t in array array['sheet_sources', 'sheet_rows', 'sheet_sync_log']
  loop
    execute format('alter table public.%I enable row level security', t);   -- no policies: no web access
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- A random password shared between the scheduler and the sync function. It is created
-- inside the database and never leaves it.
select vault.create_secret(
  encode(extensions.gen_random_bytes(32), 'hex'),
  'sheet_sync_secret',
  'Lets the scheduler call the sync-sheets function'
)
where not exists (select 1 from vault.secrets where name = 'sheet_sync_secret');

create or replace function public.check_sync_secret(p text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(length(p) > 0, false) and exists (
    select 1 from vault.decrypted_secrets
    where name = 'sheet_sync_secret' and decrypted_secret = p
  );
$$;
revoke all on function public.check_sync_secret(text) from public, anon, authenticated;
grant execute on function public.check_sync_secret(text) to service_role;

-- Swap in a fresh copy of one tab's rows in a single step, so readers never see half a sheet.
create or replace function public.sheet_replace_rows(p_source bigint, p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare n int;
begin
  delete from public.sheet_rows where source_id = p_source;
  insert into public.sheet_rows (source_id, row_no, data)
  select p_source, (r ->> 'row_no')::int, r -> 'data'
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.sheet_replace_rows(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.sheet_replace_rows(bigint, jsonb) to service_role;

-- What the dashboard is allowed to know about the sync.
create or replace function public.sync_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when not public.is_dashboard_user() then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', s.name,
      'tab', s.tab,
      'enabled', s.enabled,
      'rows', (select count(*) from public.sheet_rows r where r.source_id = s.id),
      'last_ok', (select max(l.finished_at) from public.sheet_sync_log l where l.source_id = s.id and l.status = 'ok'),
      'last_status', (select l.status from public.sheet_sync_log l where l.source_id = s.id order by l.started_at desc limit 1),
      'last_message', (select l.message from public.sheet_sync_log l where l.source_id = s.id order by l.started_at desc limit 1)
    ) order by s.name)
    from public.sheet_sources s), '[]'::jsonb) end;
$$;
revoke all on function public.sync_status() from public, anon;
grant execute on function public.sync_status() to authenticated;

-- The schedule: call the function every 15 minutes, and tidy the log once a day.
select cron.unschedule(jobid) from cron.job where jobname in ('sync-sheets', 'sync-sheets-log-cleanup');

select cron.schedule('sync-sheets', '*/15 * * * *', $cron$
  select net.http_post(
    url     := 'https://gbbzlqqzctftahjfjbzq.supabase.co/functions/v1/sync-sheets',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_sync_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
$cron$);

select cron.schedule('sync-sheets-log-cleanup', '17 3 * * *', $cron$
  delete from public.sheet_sync_log where started_at < now() - interval '30 days';
$cron$);
