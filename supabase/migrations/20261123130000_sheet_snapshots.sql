-- Copies ("snapshots") of whole sheet tabs, kept exactly as they look in the sheet.
-- Used for sheets that are laid out for reading (a P&L, a fixes list, a tracker) rather
-- than as a plain table. Loaded by scripts/load-snapshot.mjs into private seed files.
-- Readable only through the two functions below, and only by users on the allowed list.

create table if not exists public.snap_tabs (
  id        bigint generated always as identity primary key,
  sheet     text not null,                     -- the spreadsheet's name
  tab       text not null,                     -- the tab's name
  position  int  not null default 0,           -- tab order within the sheet
  copied_at timestamptz not null default now(),
  n_rows    int  not null default 0,
  n_cols    int  not null default 0,
  unique (sheet, tab)
);

create table if not exists public.snap_rows (
  tab_id bigint not null references public.snap_tabs(id) on delete cascade,
  row_no int    not null,
  cells  jsonb  not null,                      -- ["cell A", "cell B", ...] as shown in the sheet
  primary key (tab_id, row_no)
);

do $$
declare t text;
begin
  foreach t in array array['snap_tabs', 'snap_rows']
  loop
    execute format('alter table public.%I enable row level security', t);   -- no policies: no web access
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- The list of copied sheets and tabs.
create or replace function public.snap_list()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when not public.is_dashboard_user() then null else coalesce((
    select jsonb_agg(jsonb_build_object('id', t.id, 'sheet', t.sheet, 'tab', t.tab, 'copied_at', t.copied_at,
                                        'rows', t.n_rows, 'cols', t.n_cols) order by t.sheet, t.position, t.tab)
    from public.snap_tabs t), '[]'::jsonb) end;
$$;
revoke all on function public.snap_list() from public, anon;
grant execute on function public.snap_list() to authenticated;

-- One tab's rows.
create or replace function public.snap_tab(p_id bigint)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when not public.is_dashboard_user() then null else coalesce((
    select jsonb_agg(r.cells order by r.row_no) from public.snap_rows r where r.tab_id = p_id), '[]'::jsonb) end;
$$;
revoke all on function public.snap_tab(bigint) from public, anon;
grant execute on function public.snap_tab(bigint) to authenticated;
