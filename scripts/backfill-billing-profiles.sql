insert into public.billing_profiles (
  user_id,
  stripe_customer_id,
  stripe_subscription_id,
  subscription_status,
  subscription_current_period_end,
  cancel_at
)
select
  id as user_id,
  stripe_customer_id,
  stripe_subscription_id,
  subscription_status,
  subscription_current_period_end,
  null::timestamptz as cancel_at
from public.users
where stripe_customer_id is not null
   or stripe_subscription_id is not null
   or subscription_status is not null
   or subscription_current_period_end is not null
on conflict (user_id) do update
set
  stripe_customer_id = excluded.stripe_customer_id,
  stripe_subscription_id = excluded.stripe_subscription_id,
  subscription_status = excluded.subscription_status,
  subscription_current_period_end = excluded.subscription_current_period_end;
