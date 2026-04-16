create table if not exists public.billing_profiles (
  user_id uuid primary key
    references public.users (id)
    on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_status text,
  subscription_current_period_end timestamptz,
  cancel_at timestamptz,
  past_due_display_tier text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_profiles_subscription_status_check check (
    subscription_status is null
    or subscription_status in (
      'free',
      'past_due',
      'trialing',
      'trialing-cancelled',
      'pro',
      'pro-cancelled'
    )
  ),
  constraint billing_profiles_past_due_display_tier_check check (
    past_due_display_tier is null
    or past_due_display_tier in ('trialing', 'pro')
  )
);

create index if not exists billing_profiles_subscription_status_idx
  on public.billing_profiles (subscription_status);

create index if not exists billing_profiles_period_end_idx
  on public.billing_profiles (subscription_current_period_end);

create index if not exists billing_profiles_cancel_at_idx
  on public.billing_profiles (cancel_at);

create unique index if not exists billing_profiles_stripe_customer_id_idx
  on public.billing_profiles (stripe_customer_id)
  where stripe_customer_id is not null;

create unique index if not exists billing_profiles_stripe_subscription_id_idx
  on public.billing_profiles (stripe_subscription_id)
  where stripe_subscription_id is not null;

create or replace function public.set_billing_profiles_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists billing_profiles_set_updated_at on public.billing_profiles;

create trigger billing_profiles_set_updated_at
before update on public.billing_profiles
for each row
execute function public.set_billing_profiles_updated_at();

alter table public.billing_profiles enable row level security;
alter table public.billing_profiles force row level security;

revoke all on public.billing_profiles from anon, authenticated;
