import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authConfig } from "@/auth.config";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { getStripeServerClient } from "@/lib/stripe";
import { normalizePlanTier } from "@/lib/billing";

const TRIAL_PERIOD_DAYS = 7;

function getBaseUrl() {
  const configuredBaseUrl = process.env.APP_BASE_URL;
  if (!configuredBaseUrl) {
    throw new Error("Missing APP_BASE_URL.");
  }
  return configuredBaseUrl.replace(/\/$/, "");
}

export async function POST() {
  try {
    const session = await getServerSession(authConfig);
    const userId = session?.user?.id ?? null;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const supabase = createSupabaseServerClient();
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, email, name, plan_tier")
      .eq("id", userId)
      .maybeSingle();

    if (userError || !user) {
      console.error("Failed to load user for checkout:", userError);
      return NextResponse.json(
        { error: "Could not start checkout right now." },
        { status: 500 },
      );
    }

    if (normalizePlanTier(user.plan_tier) === "pro") {
      return NextResponse.json(
        {
          error: "You already have an active Pro plan.",
          code: "already_subscribed",
        },
        { status: 409 },
      );
    }

    const stripe = getStripeServerClient();
    const { data: billingProfile, error: billingProfileError } = await supabase
      .from("billing_profiles")
      .select("stripe_customer_id, stripe_subscription_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (billingProfileError) {
      console.error("Failed to load billing profile:", billingProfileError);
      return NextResponse.json(
        { error: "Could not start checkout right now." },
        { status: 500 },
      );
    }

    let stripeCustomerId = billingProfile?.stripe_customer_id ?? null;

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        name: user.name ?? undefined,
        metadata: { app_user_id: userId },
      });
      stripeCustomerId = customer.id;

      const { error: customerPersistError } = await supabase
        .from("billing_profiles")
        .upsert(
          {
            user_id: userId,
            stripe_customer_id: stripeCustomerId,
          },
          { onConflict: "user_id" },
        );

      if (customerPersistError) {
        console.error(
          "Failed to persist Stripe customer ID on user:",
          customerPersistError,
        );
      }
    }

    const applyTrial =
      !billingProfile?.stripe_subscription_id &&
      normalizePlanTier(user.plan_tier) !== "pro";
    const baseUrl = getBaseUrl();
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      payment_method_types: ["card"],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: 899,
            recurring: { interval: "month" },
            product_data: {
              name: "Sonata Pro",
              description:
                "Unlimited sheet creation and full library access. Cancel anytime.",
            },
          },
        },
      ],
      subscription_data: {
        metadata: {
          app_user_id: userId,
        },
        ...(applyTrial ? { trial_period_days: TRIAL_PERIOD_DAYS } : {}),
      },
      custom_text: {
        submit: {
          message:
            "Start your free trial now. Cancel anytime before your first charge.",
        },
      },
      metadata: {
        app_user_id: userId,
      },
      allow_promotion_codes: true,
      success_url: `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/billing/cancel`,
    });

    if (!checkoutSession.url) {
      return NextResponse.json(
        { error: "Stripe did not return a checkout URL." },
        { status: 502 },
      );
    }

    return NextResponse.json({ url: checkoutSession.url });
  } catch (error) {
    console.error("POST /api/billing/checkout error:", error);
    return NextResponse.json(
      { error: "Could not start checkout right now." },
      { status: 500 },
    );
  }
}
