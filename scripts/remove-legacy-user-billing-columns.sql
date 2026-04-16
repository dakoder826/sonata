-- Run this only after create-billing-profiles-table.sql and
-- backfill-billing-profiles.sql have completed and application code is reading
-- from public.billing_profiles.

alter table public.users
  drop column if exists stripe_customer_id,
  drop column if exists stripe_subscription_id,
  drop column if exists subscription_status,
  drop column if exists subscription_current_period_end,
  drop column if exists trial_ends_at;

drop index if exists users_stripe_customer_id_idx;
drop index if exists users_stripe_subscription_id_idx;
