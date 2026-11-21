-- P&L Planner: remove the sample data. Run this before loading real client data.
-- Only rows marked is_sample = true are removed. Real rows are left alone.
-- This cannot be undone (re-run 002_sample_data.sql to get sample rows back).

begin;

delete from public.orders       where is_sample;   -- their order lines go with them
delete from public.ad_spend     where is_sample;
delete from public.opex_monthly where is_sample;
delete from public.skus s
 where s.is_sample
   and not exists (select 1 from public.order_lines l where l.sku = s.sku);

commit;

select count(*) as sample_orders_left from public.orders where is_sample;
