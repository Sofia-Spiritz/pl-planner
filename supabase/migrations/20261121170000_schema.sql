-- P&L Planner: database framework (Sofia & Spiritz Supabase project)
-- Run once in the Sofia & Spiritz project's SQL editor. Safe to re-run.
--
-- What this creates
--   Reference tables : markets, country_market, threepls, skus
--   Order spine      : orders, order_lines (one row per order line, with every cost on it)
--   Period costs     : ad_spend (day x market x platform), opex_monthly
--   Reporting        : order_pl view (one row per order), pl_data() function (feeds the dashboard)
--
-- Every cost on an order line carries a source: 'actual' (from an invoice or payout)
-- or 'estimate' (from a rate card or model). The dashboard shows the split.
--
-- Security: row level security is on for every table. Only signed-in users whose email
-- is listed in dashboard_users can read.
-- Nobody can write from the web page; data is loaded from the SQL editor or a server job.

create table if not exists public.markets (
  code       text primary key,
  name       text not null,
  sort_order int  not null default 100
);

create table if not exists public.country_market (
  country text primary key,                       -- ISO 2-letter ship-to country
  market  text not null references public.markets(code)
);

create table if not exists public.threepls (
  code text primary key,
  name text not null
);

create table if not exists public.skus (
  sku           text primary key,
  name          text not null,
  collection    text not null default 'Unmapped', -- exactly one reporting collection per SKU
  unit_weight_g int,
  is_gift       boolean not null default false,
  is_bundle     boolean not null default false,
  is_sample     boolean not null default false
);

create table if not exists public.orders (
  id           bigint primary key,                -- Shopify order ID
  order_name   text   not null,                   -- e.g. #1001
  order_date   date   not null,                   -- in the agreed reporting timezone
  ship_country text,
  market       text   not null references public.markets(code),
  currency     text   not null default 'GBP',     -- original order currency; amounts below are in the reporting currency
  is_sample    boolean not null default false
);
create index if not exists orders_date_idx   on public.orders (order_date);
create index if not exists orders_market_idx on public.orders (market);

create table if not exists public.order_lines (
  id              bigint primary key,             -- Shopify line item ID
  order_id        bigint not null references public.orders(id) on delete cascade,
  sku             text   references public.skus(sku),
  qty             int    not null default 1,
  threepl         text   references public.threepls(code),
  revenue         numeric(12,2) not null default 0,  -- after discounts and refunds, tax still included
  tax             numeric(12,2) not null default 0,  -- tax that belongs to the ship-to market
  cogs            numeric(12,2) not null default 0,  -- FIFO landed cost of the units shipped
  cogs_src        text not null default 'estimate' check (cogs_src        in ('actual','estimate')),
  pick_pack       numeric(12,2) not null default 0,
  pick_pack_src   text not null default 'estimate' check (pick_pack_src   in ('actual','estimate')),
  shipping        numeric(12,2) not null default 0,
  shipping_src    text not null default 'estimate' check (shipping_src    in ('actual','estimate')),
  payment_fee     numeric(12,2) not null default 0,
  payment_fee_src text not null default 'estimate' check (payment_fee_src in ('actual','estimate'))
);
create index if not exists order_lines_order_idx on public.order_lines (order_id);

create table if not exists public.ad_spend (
  day       date not null,
  market    text not null references public.markets(code),
  platform  text not null,
  spend     numeric(12,2) not null default 0,
  is_sample boolean not null default false,
  primary key (day, market, platform)
);

create table if not exists public.opex_monthly (
  month     date not null,                        -- first day of the month
  category  text not null,
  amount    numeric(12,2) not null default 0,
  is_sample boolean not null default false,
  primary key (month, category)
);

-- Who may see the dashboard. Signing in is not enough: the email must also be on this list.
-- This matters because the page is public, so anyone could try to create an account.
-- Add a person from the SQL editor:  insert into public.dashboard_users (email) values ('name@example.com');
create table if not exists public.dashboard_users (
  email    text primary key,
  added_at timestamptz not null default now()
);
alter table public.dashboard_users enable row level security;   -- no policies: not readable from the web page
revoke all on public.dashboard_users from anon, authenticated;

create or replace function public.is_dashboard_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.dashboard_users u
    where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.is_dashboard_user() from public, anon;
grant execute on function public.is_dashboard_user() to authenticated;

-- Row level security: listed, signed-in users can read; nobody can write from the browser.
do $$
declare t text;
begin
  foreach t in array array['markets','country_market','threepls','skus','orders','order_lines','ad_spend','opex_monthly']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "signed-in read" on public.%I', t);
    execute format('create policy "signed-in read" on public.%I for select to authenticated using (public.is_dashboard_user())', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- One row per order, for the drill-down.
create or replace view public.order_pl
with (security_invoker = true) as
select
  o.id                                   as order_id,
  o.order_name,
  o.order_date,
  o.market,
  o.ship_country,
  string_agg(distinct l.threepl, ', ')   as threepls,
  sum(l.qty)                             as units,
  sum(l.revenue)                         as revenue,
  sum(l.tax)                             as tax,
  sum(l.revenue - l.tax)                 as net_revenue,
  sum(l.cogs)                            as cogs,
  sum(l.pick_pack)                       as pick_pack,
  sum(l.shipping)                        as shipping,
  sum(l.payment_fee)                     as payment_fee,
  sum(l.revenue - l.tax - l.cogs - l.pick_pack - l.shipping - l.payment_fee) as gross_profit,
  bool_or(l.cogs_src = 'estimate' or l.pick_pack_src = 'estimate'
       or l.shipping_src = 'estimate' or l.payment_fee_src = 'estimate')     as has_estimate
from public.orders o
join public.order_lines l on l.order_id = o.id
group by o.id;

revoke all on public.order_pl from anon;
grant select on public.order_pl to authenticated;

-- Everything the dashboard needs for a date range, in one call.
create or replace function public.pl_data(p_from date, p_to date)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'facts', coalesce((
      select jsonb_agg(f) from (
        select o.order_date as d, o.market as m, coalesce(l.threepl, 'Unknown') as t,
               coalesce(s.collection, 'Unmapped') as c,
               count(distinct o.id) as o,
               sum(l.qty) as u,
               sum(l.revenue) as rev,
               sum(l.tax) as tax,
               sum(l.cogs) as cogs,
               coalesce(sum(l.cogs)        filter (where l.cogs_src        = 'estimate'), 0) as cogs_e,
               sum(l.pick_pack) as pp,
               coalesce(sum(l.pick_pack)   filter (where l.pick_pack_src   = 'estimate'), 0) as pp_e,
               sum(l.shipping) as ship,
               coalesce(sum(l.shipping)    filter (where l.shipping_src    = 'estimate'), 0) as ship_e,
               sum(l.payment_fee) as fee,
               coalesce(sum(l.payment_fee) filter (where l.payment_fee_src = 'estimate'), 0) as fee_e
        from order_lines l
        join orders o on o.id = l.order_id
        left join skus s on s.sku = l.sku
        where o.order_date between p_from and p_to
        group by 1, 2, 3, 4
      ) f), '[]'::jsonb),
    'orders', coalesce((
      select jsonb_agg(x) from (
        select o.order_date as d, o.market as m, coalesce(l.threepl, 'Unknown') as t,
               count(distinct o.id) as o
        from order_lines l
        join orders o on o.id = l.order_id
        where o.order_date between p_from and p_to
        group by 1, 2, 3
      ) x), '[]'::jsonb),
    'marketing', coalesce((
      select jsonb_agg(x) from (
        select day as d, market as m, platform as p, sum(spend) as s
        from ad_spend
        where day between p_from and p_to
        group by 1, 2, 3
      ) x), '[]'::jsonb),
    'opex', coalesce((
      select jsonb_agg(x) from (
        select to_char(month, 'YYYY-MM-DD') as month, category as cat, amount as amt
        from opex_monthly
        where month between date_trunc('month', p_from)::date and p_to
      ) x), '[]'::jsonb),
    'meta', jsonb_build_object(
      'sample',   exists (select 1 from orders where is_sample),
      'min',      (select min(order_date) from orders),
      'max',      (select max(order_date) from orders),
      'markets',  coalesce((select jsonb_agg(jsonb_build_object('code', code, 'name', name) order by sort_order, code) from markets), '[]'::jsonb),
      'threepls', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'name', name) order by code) from threepls), '[]'::jsonb)
    )
  );
$$;

revoke all on function public.pl_data(date, date) from public, anon;
grant execute on function public.pl_data(date, date) to authenticated;
