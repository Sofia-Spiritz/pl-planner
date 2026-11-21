-- P&L Planner: SAMPLE DATA ONLY. None of these numbers are real.
-- Loaded by: npx supabase db push --remote --include-seed (or paste into the SQL editor).
-- Makes about 180 days of invented orders so the dashboard has something to show.
-- Every sample row is marked is_sample = true; 003_clear_sample_data.sql removes them all.
-- Safe to re-run: it replaces the earlier sample rows.

begin;

select setseed(0.42);

insert into public.markets (code, name, sort_order) values
  ('UK','United Kingdom',1), ('US','United States',2), ('EU','Europe',3),
  ('AU','Australia',4), ('CA','Canada',5), ('ROW','Rest of world',6)
on conflict (code) do nothing;

insert into public.country_market (country, market) values
  ('GB','UK'), ('US','US'), ('DE','EU'), ('FR','EU'), ('NL','EU'),
  ('AU','AU'), ('CA','CA'), ('AE','ROW')
on conflict (country) do nothing;

insert into public.threepls (code, name) values
  ('B3PL','B3PL (UK)'), ('PORTLESS','Portless')
on conflict (code) do nothing;

-- Earlier sample rows out first (order lines go with their orders).
delete from public.orders       where is_sample;
delete from public.ad_spend     where is_sample;
delete from public.opex_monthly where is_sample;

create temp table _sku (sku text, name text, collection text, weight int, price numeric, cost numeric, gift boolean) on commit drop;
insert into _sku values
  ('S-BAG-TOTE-BLK',  'Sample tote bag, black',       'Bags',          620, 89, 21.50, false),
  ('S-BAG-TOTE-TAN',  'Sample tote bag, tan',         'Bags',          620, 89, 22.10, false),
  ('S-BAG-CROSS-BLK', 'Sample crossbody bag, black',  'Bags',          410, 69, 16.40, false),
  ('S-BAG-CROSS-OLV', 'Sample crossbody bag, olive',  'Bags',          410, 69, 16.90, false),
  ('S-BAG-MINI-RED',  'Sample mini bag, red',         'Bags',          280, 55, 12.80, false),
  ('S-CASE-HARD-BLK', 'Sample hard glasses case',     'Glasses cases', 140, 29,  5.60, false),
  ('S-CASE-SOFT-TAN', 'Sample soft glasses case',     'Glasses cases',  90, 24,  4.20, false),
  ('S-CASE-FOLD-NVY', 'Sample folding glasses case',  'Glasses cases', 120, 32,  6.90, false),
  ('S-STRAP-WIDE',    'Sample wide strap',            'Straps',         95, 22,  3.80, false),
  ('S-STRAP-CHAIN',   'Sample chain strap',           'Straps',        160, 26,  5.10, false),
  ('S-ACC-CHARM',     'Sample bag charm',             'Accessories',    30, 14,  2.10, false),
  ('S-ACC-POUCH',     'Sample zip pouch',             'Accessories',    70, 18,  3.40, false),
  ('S-GIFT-CLOTH',    'Sample free gift: lens cloth', 'Free gifts',     10,  0,  0.90, true);

insert into public.skus (sku, name, collection, unit_weight_g, is_gift, is_sample)
select sku, name, collection, weight, gift, true from _sku
on conflict (sku) do nothing;

-- Orders: one row per invented order, with the random draws it needs.
create temp table _o on commit drop as
with days as (
  select d::date as d,
         (46 + 20 * random()
             + case when extract(isodow from d) >= 6 then 10 else 0 end
             + (180 - (current_date - d::date)) / 12.0)::int as cnt
  from generate_series(current_date - 180, current_date - 1, interval '1 day') d
), o as (
  select d, n from days cross join lateral generate_series(1, cnt) n
), r as (
  select row_number() over (order by d, n) as rn, d,
         random()::numeric as r_m, random()::numeric as r_c, random()::numeric as r_l,
         random()::numeric as r_s, random()::numeric as r_g
  from o
), m as (
  select *,
         case when r_m < .42 then 'UK' when r_m < .67 then 'US' when r_m < .82 then 'EU'
              when r_m < .90 then 'AU' when r_m < .95 then 'CA' else 'ROW' end as market
  from r
)
select 900000000000 + rn as id,
       '#S' || (10000 + rn) as order_name,
       d, market, r_c, r_s, r_g,
       case market when 'UK' then 'GB' when 'US' then 'US' when 'AU' then 'AU' when 'CA' then 'CA' when 'ROW' then 'AE'
            else case when r_c < .4 then 'DE' when r_c < .75 then 'FR' else 'NL' end end as country,
       case when market = 'UK' or (market = 'EU' and r_c < .3) then 'B3PL' else 'PORTLESS' end as threepl,
       case when r_l < .6 then 1 when r_l < .9 then 2 else 3 end as nlines
from m;

insert into public.orders (id, order_name, order_date, ship_country, market, currency, is_sample)
select id, order_name, d, country, market, 'GBP', true from _o;

-- Lines: 1 to 3 products per order.
insert into public.order_lines
  (id, order_id, sku, qty, threepl, revenue, tax, cogs, cogs_src,
   pick_pack, pick_pack_src, shipping, shipping_src, payment_fee, payment_fee_src)
with l as materialized (
  select o.*, k as line_no,
         random()::numeric as r_sku, random()::numeric as r_q, random()::numeric as r_d, random()::numeric as r_cost
  from _o o cross join lateral generate_series(1, o.nlines) k
), s as (
  select *, row_number() over (order by sku) as rn, count(*) over () as cnt
  from _sku where not gift
), v as (
  select l.*, s.sku, s.cost,
         case when l.r_q < .1 then 2 else 1 end as qty,
         round(s.price * (case when l.r_q < .1 then 2 else 1 end)
               * (1 - case when l.r_d < .35 then 0.10 + 0.10 * l.r_d else 0 end), 2) as revenue,
         case when l.threepl = 'B3PL' then l.r_s < .80 else l.r_s < .65 end as inv_matched
  from l join s on s.rn = 1 + floor(l.r_sku * s.cnt)::int
)
select id * 10 + line_no, id, sku, qty, threepl,
       revenue,
       round(revenue * case market when 'UK' then 1 / 6.0 when 'EU' then 0.16 when 'AU' then 1 / 11.0 else 0 end, 2),
       round(cost * qty * (0.95 + 0.10 * r_cost), 2),
       case when r_cost < .20 then 'estimate' else 'actual' end,
       round(case when line_no = 1 then case threepl when 'B3PL' then 1.85 else 1.40 end
                  else case threepl when 'B3PL' then 0.45 else 0.30 end end * qty, 2),
       case when inv_matched then 'actual' else 'estimate' end,
       round(case market when 'UK' then 3.20 when 'US' then 7.50 when 'EU' then 5.80
                         when 'AU' then 9.50 when 'CA' then 8.40 else 11.00 end
             * (0.85 + 0.30 * r_g) / nlines, 2),
       case when inv_matched then 'actual' else 'estimate' end,
       round(revenue * case when market = 'UK' then 0.019 else 0.029 end
             + case when line_no = 1 then case when market = 'UK' then 0.20 else 0.25 end else 0 end, 2),
       case when r_c < .85 then 'actual' else 'estimate' end
from v;

-- Free gift on about 1 order in 8: no revenue, real cost.
insert into public.order_lines
  (id, order_id, sku, qty, threepl, revenue, tax, cogs, cogs_src,
   pick_pack, pick_pack_src, shipping, shipping_src, payment_fee, payment_fee_src)
select id * 10 + 9, id, 'S-GIFT-CLOTH', 1, threepl, 0, 0, 0.90, 'actual',
       0.30, 'estimate', 0, 'actual', 0, 'actual'
from _o where r_g < .12;

-- Ad spend: roughly a quarter of each market's net revenue, split over three platforms.
insert into public.ad_spend (day, market, platform, spend, is_sample)
select o.order_date, o.market, p.platform,
       round(sum(l.revenue - l.tax) * 0.24 * p.share * (0.8 + 0.4 * random())::numeric, 2), true
from public.orders o
join public.order_lines l on l.order_id = o.id
cross join (values ('Meta', 0.60), ('Google', 0.30), ('TikTok', 0.10)) as p(platform, share)
where o.is_sample
group by o.order_date, o.market, p.platform, p.share;

-- Monthly overheads.
insert into public.opex_monthly (month, category, amount, is_sample)
select m::date, c.category, c.amount, true
from generate_series(date_trunc('month', current_date - 180), date_trunc('month', current_date), interval '1 month') m
cross join (values ('Salaries', 14000), ('Agency and freelancers', 3500), ('Software', 2100),
                   ('Rent and office', 1200), ('Other', 900)) as c(category, amount);

commit;

-- Quick check: should show about 180 days and several thousand orders.
select count(*) as sample_orders, min(order_date) as first_day, max(order_date) as last_day
from public.orders where is_sample;
