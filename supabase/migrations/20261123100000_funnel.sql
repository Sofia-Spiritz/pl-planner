-- Real marketing-funnel figures, loaded from the client's Daily Funnel Sheet.
-- Loaded by scripts/load-funnel.mjs (which writes a private, uncommitted seed file).
-- None of these tables can be read from the web page; the dashboard gets them through
-- funnel_data(), and only for users on the allowed list.

create table if not exists public.funnel_daily (
  day                date not null,
  market             text not null,               -- UK, US, AU
  meta_spend         numeric(14,2),
  google_spend       numeric(14,2),
  applovin_spend     numeric(14,2),
  ad_spend           numeric(14,2),
  shopify_sales      numeric(14,2),               -- inc. VAT, as the sheet reports it
  new_customer_sales numeric(14,2),
  net_revenue        numeric(14,2),               -- ex VAT
  contribution       numeric(14,2),               -- contribution profit after ads
  primary key (day, market)
);

create table if not exists public.funnel_category_daily (
  day             date not null,
  market          text not null,
  category        text not null,                  -- Bags, Glasses cases
  meta_spend      numeric(14,2),
  google_spend    numeric(14,2),
  applovin_spend  numeric(14,2),
  new_sales       numeric(14,2),
  returning_sales numeric(14,2),
  primary key (day, market, category)
);

create table if not exists public.funnel_monthly_market (
  month                   date not null,
  market                  text not null,
  segment                 text not null,
  meta_spend              numeric(14,2),
  google_spend            numeric(14,2),
  applovin_spend          numeric(14,2),
  ad_spend                numeric(14,2),
  shopify_sales           numeric(14,2),
  new_customer_sales      numeric(14,2),
  net_revenue             numeric(14,2),
  gross_profit_before_ads numeric(14,2),
  contribution            numeric(14,2),
  primary key (month, market, segment)
);

create table if not exists public.funnel_app_costs (
  month    date not null,
  item     text not null,
  amount   numeric(14,2) not null,
  currency text not null default 'GBP',
  is_total boolean not null default false,       -- the sheet's own monthly total row
  primary key (month, item, currency)
);

create table if not exists public.funnel_meta (
  key   text primary key,
  value text
);

do $$
declare t text;
begin
  foreach t in array array['funnel_daily','funnel_category_daily','funnel_monthly_market','funnel_app_costs','funnel_meta']
  loop
    execute format('alter table public.%I enable row level security', t);   -- no policies: no web access
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

create or replace function public.funnel_data(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when not public.is_dashboard_user() then null else jsonb_build_object(
    'daily', coalesce((select jsonb_agg(to_jsonb(d) order by d.day, d.market)
                       from public.funnel_daily d where d.day between p_from and p_to), '[]'::jsonb),
    'category', coalesce((select jsonb_agg(to_jsonb(c) order by c.day, c.market, c.category)
                          from public.funnel_category_daily c where c.day between p_from and p_to), '[]'::jsonb),
    'monthly', coalesce((select jsonb_agg(to_jsonb(m) order by m.month, m.market, m.segment)
                         from public.funnel_monthly_market m
                         where m.month between date_trunc('month', p_from)::date and p_to), '[]'::jsonb),
    'costs', coalesce((select jsonb_agg(to_jsonb(a) order by a.month, a.is_total, a.item)
                       from public.funnel_app_costs a
                       where a.month between date_trunc('month', p_from)::date and p_to), '[]'::jsonb),
    'meta', jsonb_build_object(
      'exported_at', (select value from public.funnel_meta where key = 'exported_at'),
      'source',      (select value from public.funnel_meta where key = 'source'),
      'min',         (select min(day) from public.funnel_daily),
      'max',         (select max(day) from public.funnel_daily)
    )
  ) end;
$$;
revoke all on function public.funnel_data(date, date) from public, anon;
grant execute on function public.funnel_data(date, date) to authenticated;
