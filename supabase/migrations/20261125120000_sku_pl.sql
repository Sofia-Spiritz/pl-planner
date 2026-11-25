-- Estimated profit per SKU and market for a period.
-- Built by scripts/build-sku-pl.mjs (which writes a private, uncommitted seed file):
-- revenue is actual from Shopify sales lines, every cost is an estimate from the client's own rates.
-- Neither table can be read from the web page; the dashboard gets them through sku_pl_data(),
-- and only for users on the allowed list.

create table if not exists public.sku_pl (
  period_from     date not null,
  period_to       date not null,
  market          text not null,                 -- UK, US, AU, Other
  three_pl        text not null,                 -- which warehouse ships this market in the period
  sku             text not null,
  title           text not null default '',
  collection      text not null default 'Other', -- Bags, Glasses cases, Straps ...
  is_gift         boolean not null default false,-- a "-1" free-gift SKU
  units           numeric(14,2) not null default 0,
  gross_sales     numeric(14,2) not null default 0,
  discounts       numeric(14,2) not null default 0,
  net_sales       numeric(14,2) not null default 0,
  shipping_income numeric(14,2) not null default 0,
  product_cost    numeric(14,2) not null default 0,
  duty_freight    numeric(14,2) not null default 0,
  pick_pack       numeric(14,2) not null default 0,
  postage         numeric(14,2) not null default 0,
  payment_fees    numeric(14,2) not null default 0,
  ad_spend        numeric(14,2) not null default 0,
  primary key (period_from, period_to, market, sku)
);

create table if not exists public.sku_pl_meta (
  period_from date not null,
  period_to   date not null,
  built_at    timestamptz not null default now(),
  notes       jsonb not null default '{}'::jsonb, -- how each line was worked out
  primary key (period_from, period_to)
);

do $$
declare t text;
begin
  foreach t in array array['sku_pl','sku_pl_meta']
  loop
    execute format('alter table public.%I enable row level security', t);   -- no policies: no web access
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- The latest period by default, or the one starting on p_from.
create or replace function public.sku_pl_data(p_from date default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with pick as (
    select m.period_from, m.period_to, m.built_at, m.notes
    from public.sku_pl_meta m
    where p_from is null or m.period_from = p_from
    order by m.period_from desc
    limit 1
  )
  select case when not public.is_dashboard_user() then null else jsonb_build_object(
    'period', (select jsonb_build_object('from', period_from, 'to', period_to, 'built_at', built_at, 'notes', notes) from pick),
    'periods', coalesce((select jsonb_agg(jsonb_build_object('from', m.period_from, 'to', m.period_to) order by m.period_from desc)
                         from public.sku_pl_meta m), '[]'::jsonb),
    'rows', coalesce((select jsonb_agg(to_jsonb(s) - 'period_from' - 'period_to' order by s.net_sales desc)
                      from public.sku_pl s, pick p
                      where s.period_from = p.period_from and s.period_to = p.period_to), '[]'::jsonb)
  ) end;
$$;
revoke all on function public.sku_pl_data(date) from public, anon;
grant execute on function public.sku_pl_data(date) to authenticated;
