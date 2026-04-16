update public.billing_profiles
set subscription_status = case
  when subscription_status in ('pro', 'pro-cancelled', 'trialing', 'trialing-cancelled', 'free', 'past_due') then subscription_status
  when subscription_status = 'active' then 'pro'
  when subscription_status = 'active-cancelled' then 'pro-cancelled'
  when subscription_status = 'canceled' then 'free'
  else 'free'
end;

alter table public.billing_profiles
  add column if not exists past_due_display_tier text;

update public.billing_profiles as bp
set past_due_display_tier = case
  when bp.subscription_status = 'past_due' and u.plan_tier in ('trialing', 'trialing-cancelled') then 'trialing'
  when bp.subscription_status = 'past_due' then 'pro'
  else null
end
from public.users as u
where u.id = bp.user_id;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'billing_profiles_subscription_status_check'
      and conrelid = 'public.billing_profiles'::regclass
  ) then
    alter table public.billing_profiles
      drop constraint billing_profiles_subscription_status_check;
  end if;

  alter table public.billing_profiles
    add constraint billing_profiles_subscription_status_check
    check (
      subscription_status is null
      or subscription_status in (
        'free',
        'past_due',
        'trialing',
        'trialing-cancelled',
        'pro',
        'pro-cancelled'
      )
    );

  if exists (
    select 1
    from pg_constraint
    where conname = 'billing_profiles_past_due_display_tier_check'
      and conrelid = 'public.billing_profiles'::regclass
  ) then
    alter table public.billing_profiles
      drop constraint billing_profiles_past_due_display_tier_check;
  end if;

  alter table public.billing_profiles
    add constraint billing_profiles_past_due_display_tier_check
    check (
      past_due_display_tier is null
      or past_due_display_tier in ('trialing', 'pro')
    );
end
$$;
