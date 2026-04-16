alter table public.users
  add column if not exists plan_tier text not null default 'free',
  add column if not exists last_seen timestamptz;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'users_plan_tier_check'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      drop constraint users_plan_tier_check;
  end if;

  alter table public.users
    add constraint users_plan_tier_check
    check (
      plan_tier in ('free', 'past_due', 'trialing', 'trialing-cancelled', 'pro', 'pro-cancelled')
    );
end
$$;

-- Stripe lifecycle fields now live in public.billing_profiles.
-- See scripts/create-billing-profiles-table.sql and scripts/backfill-billing-profiles.sql.
