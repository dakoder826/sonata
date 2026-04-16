"use client";

import Link from "next/link";
import { useState } from "react";
import { useSession } from "next-auth/react";

const PRICING_PLANS = [
  {
    name: "Free",
    price: "$0",
    cadence: "/month",
    description: "Great for trying Sonata and building your first sheet.",
    features: [
      "1 active sheet at a time",
      "Playback + staff view",
      "MIDI/PDF downloads",
    ],
    ctaLabel: "Start free",
    ctaStyle:
      "inline-flex items-center justify-center rounded-full border border-white/25 px-5 py-2.5 text-sm font-medium text-white transition hover:border-white/50 hover:bg-white/5",
  },
  {
    name: "Pro",
    price: "$8.99",
    cadence: "/month",
    description: "For regular use with unlimited creation and account billing.",
    trialHighlight: "7-day free trial",
    features: [
      "Unlimited active sheets",
      "7-day free trial on upgrade",
      "Manage/cancel anytime in billing portal",
    ],
    ctaLabel: "Upgrade to Pro",
    ctaStyle:
      "inline-flex items-center justify-center rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-neutral-950 transition hover:bg-neutral-200",
    highlight: true,
  },
];

export default function PricingPlans({
  id = "pricing",
  freeCtaHref = "#convert",
  proCtaHref = "/sheets",
}) {
  const { data: session } = useSession();
  const [billingAction, setBillingAction] = useState("");
  const subscriptionStatus = session?.user?.subscriptionStatus ?? "";
  const isSignedIn = Boolean(session?.user?.id);
  const hasProOrTrialAccess =
    subscriptionStatus === "pro" ||
    subscriptionStatus === "pro-cancelled" ||
    subscriptionStatus === "trialing" ||
    subscriptionStatus === "trialing-cancelled";

  async function handleBillingNavigation(endpoint, action) {
    setBillingAction(action);
    try {
      const response = await fetch(endpoint, { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.url) {
        throw new Error(data?.error || "Unable to continue to billing.");
      }
      window.location.href = data.url;
    } catch (error) {
      window.alert(error.message || "Unable to continue to billing.");
      setBillingAction("");
    }
  }

  return (
    <section
      id={id}
      className="scroll-mt-24 border-b border-white/10 py-20 md:py-28"
    >
      <div className="mx-auto max-w-6xl px-4 md:px-6">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
            Pricing
          </h2>
          <p className="mt-3 text-neutral-400 md:text-lg">
            Start free, then upgrade when you want unlimited sheet creation.
          </p>
        </div>
        <div className="mt-12 grid gap-5 md:grid-cols-2">
          {PRICING_PLANS.map((plan) => {
            const isFreePlan = plan.name === "Free";
            const ctaHref = isFreePlan ? "/sheets" : proCtaHref;
            const shouldUseBillingEndpoint = !isFreePlan && isSignedIn;
            const billingEndpoint = hasProOrTrialAccess
              ? "/api/billing/portal"
              : "/api/billing/checkout";
            const isOpening =
              billingAction === (hasProOrTrialAccess ? "portal" : "checkout");
            const ctaLabel =
              shouldUseBillingEndpoint && hasProOrTrialAccess
                ? "Manage billing"
                : !isFreePlan
                  ? "Start 7-day free trial"
                  : plan.ctaLabel;
            return (
              <article
                key={plan.name}
                className={`rounded-2xl border p-6 ${
                  plan.highlight
                    ? "border-white/35 bg-white/5"
                    : "border-white/15 bg-neutral-900/40"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium tracking-wide text-neutral-300 uppercase">
                    {plan.name}
                  </p>
                  {plan.trialHighlight ? (
                    <span className="rounded-full border border-emerald-300/45 bg-emerald-500/20 px-2.5 py-1 text-[10px] font-semibold tracking-wide text-emerald-100 uppercase">
                      {plan.trialHighlight}
                    </span>
                  ) : null}
                </div>
                <div className="mt-3 flex items-end gap-1">
                  <span className="text-4xl font-semibold tracking-tight text-white">
                    {plan.price}
                  </span>
                  <span className="mb-1 text-sm text-neutral-400">
                    {plan.cadence}
                  </span>
                </div>
                {plan.trialHighlight ? (
                  <p className="mt-3 rounded-xl border border-emerald-300/30 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-100">
                    Try all Pro features free for 7 days, then continue at $8.99/month.
                  </p>
                ) : null}
                <p className="mt-3 text-sm text-neutral-400">
                  {plan.description}
                </p>
                <ul className="mt-6 space-y-2 text-sm text-neutral-300">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2">
                      <span className="mt-1 h-1.5 w-1.5 rounded-full bg-white/60" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                {shouldUseBillingEndpoint ? (
                  <button
                    type="button"
                    onClick={() =>
                      handleBillingNavigation(
                        billingEndpoint,
                        hasProOrTrialAccess ? "portal" : "checkout",
                      )
                    }
                    disabled={isOpening}
                    className={`mt-8 ${plan.ctaStyle} ${isOpening ? "cursor-not-allowed opacity-80" : ""}`}
                  >
                    {isOpening ? "Opening..." : ctaLabel}
                  </button>
                ) : (
                  <Link href={ctaHref} className={`mt-8 ${plan.ctaStyle}`}>
                    {ctaLabel}
                  </Link>
                )}
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
