-- Live sheets can now come from a whole Google Drive folder, and can be Excel files.
--
--   sheet_folders : Drive folders to watch. Every spreadsheet in the folder (including
--                   shortcuts to spreadsheets) is read, one sheet_sources row per tab.
--   sheet_sources : gains file_name (look a file up by name), folder_id and auto
--                   (rows the sync created by itself from a folder).
--                   spreadsheet_id and tab are optional now: a missing ID is looked up by
--                   name, and a missing tab means the first tab.

create table if not exists public.sheet_folders (
  id        bigint generated always as identity primary key,
  name      text    not null unique,
  folder_id text    not null unique,          -- the ID in the folder's web address
  enabled   boolean not null default true
);
alter table public.sheet_folders enable row level security;   -- no policies: no web access
revoke all on public.sheet_folders from anon, authenticated;
grant all on public.sheet_folders to service_role;

alter table public.sheet_sources add column if not exists file_name text;
alter table public.sheet_sources add column if not exists folder_id bigint references public.sheet_folders(id) on delete cascade;
alter table public.sheet_sources add column if not exists auto boolean not null default false;
alter table public.sheet_sources alter column spreadsheet_id drop not null;
alter table public.sheet_sources alter column tab drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sheet_sources_has_file') then
    alter table public.sheet_sources
      add constraint sheet_sources_has_file check (spreadsheet_id is not null or file_name is not null);
  end if;
end $$;
