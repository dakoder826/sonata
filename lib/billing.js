const PRO_SUBSCRIPTION_STATUSES = new Set([
  "pro",
  "pro-cancelled",
  "trialing",
  "trialing-cancelled",
  "active",
  "past_due",
  "active-cancelled",
]);

export function normalizePlanTier(value) {
  if (value === "pro") return "pro";
  if (PRO_SUBSCRIPTION_STATUSES.has(value)) return "pro";
  return "free";
}

export function getPlanFromSubscriptionStatus(status) {
  return PRO_SUBSCRIPTION_STATUSES.has(status) ? "pro" : "free";
}

export function getTrialPeriodDays() {
  const raw = process.env.STRIPE_TRIAL_PERIOD_DAYS;
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 7;
  }
  return parsed;
}

export function toIsoTimestampFromUnix(unixSeconds) {
  if (!Number.isFinite(unixSeconds)) return null;
  return new Date(unixSeconds * 1000).toISOString();
}
