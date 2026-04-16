update public.users as u
set plan_tier = case
  when bp.subscription_status in ('pro', 'pro-cancelled', 'trialing', 'trialing-cancelled', 'free', 'past_due') then bp.subscription_status
  when bp.subscription_status = 'active' then 'pro'
  when bp.subscription_status = 'active-cancelled' then 'pro-cancelled'
  when bp.subscription_status = 'canceled' then 'free'
  else 'free'
end
from public.billing_profiles as bp
where bp.user_id = u.id
  and bp.subscription_status is not null
  and u.plan_tier is distinct from case
    when bp.subscription_status in ('pro', 'pro-cancelled', 'trialing', 'trialing-cancelled', 'free', 'past_due') then bp.subscription_status
    when bp.subscription_status = 'active' then 'pro'
    when bp.subscription_status = 'active-cancelled' then 'pro-cancelled'
    when bp.subscription_status = 'canceled' then 'free'
    else 'free'
  end;
