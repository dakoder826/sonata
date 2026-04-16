import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { getStripeServerClient } from "@/lib/stripe";
import {
  toIsoTimestampFromUnix,
} from "@/lib/billing";

export const runtime = "nodejs";

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function parseTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function hasScheduledCancellation(subscription) {
  const cancelAt = subscription?.cancel_at;
  if (!Number.isFinite(cancelAt)) return false;

  const nowInSeconds = Math.floor(Date.now() / 1000);
  if (cancelAt <= nowInSeconds || subscription?.canceled_at) {
    return false;
  }

  return true;
}

function toCanonicalSubscriptionStatus(subscription, eventType) {
  if (eventType === "customer.subscription.deleted") {
    return "free";
  }

  const stripeStatus = subscription?.status;
  if (!stripeStatus) return "free";
  const cancelAt = subscription?.cancel_at;
  const nowInSeconds = Math.floor(Date.now() / 1000);
  const hasReachedCancelAt =
    Number.isFinite(cancelAt) && cancelAt <= nowInSeconds;

  if (stripeStatus === "canceled" || subscription?.canceled_at || hasReachedCancelAt) {
    return "free";
  }

  const isScheduledCancellation = hasScheduledCancellation(subscription);
  if (stripeStatus === "trialing") {
    return isScheduledCancellation ? "trialing-cancelled" : "trialing";
  }

  if (stripeStatus === "past_due") {
    return "past_due";
  }

  if (stripeStatus === "active") {
    return isScheduledCancellation ? "pro-cancelled" : "pro";
  }

  return "free";
}

function getSubscriptionPeriodEndIso(subscription) {
  let periodEnd = subscription?.current_period_end;
  if (
    !periodEnd &&
    subscription?.status === "trialing" &&
    subscription?.trial_end
  ) {
    periodEnd = subscription.trial_end;
  }
  return toIsoTimestampFromUnix(periodEnd);
}

function toUserPlanTier(subscriptionStatus) {
  return subscriptionStatus ?? "free";
}

async function sendBillingNotification({
  subject,
  heading,
  userEmail,
  subscriptionStatus,
  lines = [],
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return;
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Sonata <onboarding@resend.dev>",
        to: ["chibernard321@gmail.com"],
        subject,
        html: `
          <h2>${heading}</h2>
          <p><strong>User:</strong> ${userEmail ?? "unknown"}</p>
          <p><strong>Status:</strong> ${subscriptionStatus ?? "unknown"}</p>
          <ul>${lines
            .filter(Boolean)
            .map((line) => `<li>${line}</li>`)
            .join("")}</ul>
          <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
        `,
      }),
    });

    if (!response.ok) {
      console.error(
        "Failed to send billing notification via Resend:",
        await response.text(),
      );
    }
  } catch (error) {
    console.error("Unexpected error sending billing notification:", error);
  }
}

async function getUserById(userId) {
  if (!userId) return null;
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("users")
    .select("id, email, plan_tier")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ?? null;
}

async function getUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("users")
    .select("id, email, plan_tier")
    .eq("email", normalizedEmail)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ?? null;
}

async function updateUserById(userId, updates) {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from("users")
    .update(updates)
    .eq("id", userId);
  if (error) {
    throw error;
  }
}

async function getBillingProfileByUserId(userId) {
  if (!userId) return null;
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("billing_profiles")
    .select(
      "user_id, stripe_customer_id, stripe_subscription_id, subscription_status, subscription_current_period_end, cancel_at, past_due_display_tier",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ?? null;
}

async function getBillingProfileByCustomerId(customerId) {
  if (!customerId) return null;
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("billing_profiles")
    .select(
      "user_id, stripe_customer_id, stripe_subscription_id, subscription_status, subscription_current_period_end, cancel_at, past_due_display_tier",
    )
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ?? null;
}

async function upsertBillingProfile(userId, updates) {
  const supabase = createSupabaseServerClient();
  const payload = { user_id: userId, ...updates };
  const { data, error } = await supabase
    .from("billing_profiles")
    .upsert(payload, { onConflict: "user_id" })
    .select(
      "user_id, stripe_customer_id, stripe_subscription_id, subscription_status, subscription_current_period_end, cancel_at, past_due_display_tier",
    )
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function notifyOnStateTransition({
  previousProfile,
  currentProfile,
  userEmail,
  eventType,
}) {
  const previousStatus = previousProfile?.subscription_status ?? null;
  const currentStatus = currentProfile?.subscription_status ?? null;
  const previousEnd = parseTimestamp(
    previousProfile?.subscription_current_period_end,
  );
  const currentEnd = parseTimestamp(
    currentProfile?.subscription_current_period_end,
  );

  if (eventType === "checkout.session.completed") {
    await sendBillingNotification({
      subject: "Sonata billing: checkout completed",
      heading: "Checkout Completed",
      userEmail,
      subscriptionStatus: currentStatus,
      lines: [
        "A checkout session completed and was synced.",
        currentProfile?.subscription_current_period_end
          ? `Current period ends: ${currentProfile.subscription_current_period_end}`
          : null,
      ],
    });
    return;
  }

  const movedFromTrialToPaid =
    (previousStatus === "trialing" ||
      previousStatus === "trialing-cancelled") &&
    (currentStatus === "pro" || currentStatus === "pro-cancelled");
  const becameCancelled =
    currentStatus === "free" &&
    previousStatus &&
    previousStatus !== "free";
  const becameScheduledCancellation =
    (currentStatus === "pro-cancelled" ||
      currentStatus === "trialing-cancelled") &&
    currentStatus !== previousStatus;
  const renewed =
    (previousStatus === "pro" || previousStatus === "pro-cancelled") &&
    (currentStatus === "pro" || currentStatus === "pro-cancelled") &&
    Number.isFinite(previousEnd) &&
    Number.isFinite(currentEnd) &&
    currentEnd > previousEnd;

  if (becameCancelled) {
    await sendBillingNotification({
      subject: "Sonata billing: subscription canceled",
      heading: "Subscription Canceled",
      userEmail,
      subscriptionStatus: currentStatus,
      lines: ["User moved back to free entitlement."],
    });
    return;
  }

  if (becameScheduledCancellation) {
    await sendBillingNotification({
      subject: "Sonata billing: cancellation scheduled",
      heading: "Cancellation Scheduled",
      userEmail,
      subscriptionStatus: currentStatus,
      lines: [
        currentProfile?.cancel_at
          ? `Scheduled cancel_at: ${currentProfile.cancel_at}`
          : "Cancellation scheduled at period end.",
      ],
    });
    return;
  }

  if (movedFromTrialToPaid) {
    await sendBillingNotification({
      subject: "Sonata billing: trial converted",
      heading: "Trial Converted",
      userEmail,
      subscriptionStatus: currentStatus,
      lines: ["User converted from trial to paid status."],
    });
    return;
  }

  if (renewed) {
    await sendBillingNotification({
      subject: "Sonata billing: subscription renewed",
      heading: "Subscription Renewed",
      userEmail,
      subscriptionStatus: currentStatus,
      lines: [
        currentProfile?.subscription_current_period_end
          ? `New period end: ${currentProfile.subscription_current_period_end}`
          : null,
      ],
    });
  }
}

async function findUserIdForSubscription({
  userIdHint,
  customerId,
  customerEmailHint,
}) {
  if (userIdHint) return userIdHint;

  const existingProfile = await getBillingProfileByCustomerId(customerId);
  if (existingProfile?.user_id) return existingProfile.user_id;

  const userByEmail = await getUserByEmail(customerEmailHint);
  return userByEmail?.id ?? null;
}

async function syncFromSubscription({
  subscription,
  userIdHint = null,
  eventType = "subscription_sync",
}) {
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer?.id;
  const stripe = getStripeServerClient();
  const customer = customerId
    ? await stripe.customers.retrieve(customerId).catch(() => null)
    : null;
  const customerEmail = normalizeEmail(customer?.email);

  const userId = await findUserIdForSubscription({
    userIdHint,
    customerId,
    customerEmailHint: customerEmail,
  });

  if (!userId) {
    console.warn(
      "Skipping subscription sync: unable to resolve user for subscription.",
      subscription.id,
    );
    return;
  }

  const previousProfile = await getBillingProfileByUserId(userId);
  if (
    previousProfile?.stripe_subscription_id &&
    previousProfile.stripe_subscription_id !== subscription.id
  ) {
    console.log(
      `Ignoring stale subscription event for user ${userId}. Incoming: ${subscription.id}, linked: ${previousProfile.stripe_subscription_id}`,
    );
    return;
  }

  const derivedStatus = toCanonicalSubscriptionStatus(subscription, eventType);
  const periodEndIso =
    derivedStatus === "free" ? null : getSubscriptionPeriodEndIso(subscription);
  const cancelAtIso =
    derivedStatus === "trialing-cancelled" || derivedStatus === "pro-cancelled"
      ? toIsoTimestampFromUnix(subscription.cancel_at)
      : null;
  const pastDueDisplayTier =
    derivedStatus === "past_due"
      ? previousProfile?.past_due_display_tier === "trialing" ||
        previousProfile?.subscription_status === "trialing" ||
        previousProfile?.subscription_status === "trialing-cancelled"
        ? "trialing"
        : "pro"
      : null;

  const profile = await upsertBillingProfile(userId, {
    stripe_customer_id:
      customerId ?? previousProfile?.stripe_customer_id ?? null,
    stripe_subscription_id: subscription.id,
    subscription_status: derivedStatus,
    subscription_current_period_end: periodEndIso,
    cancel_at: cancelAtIso,
    past_due_display_tier: pastDueDisplayTier,
  });

  await updateUserById(userId, {
    plan_tier: toUserPlanTier(derivedStatus),
  });

  const user = await getUserById(userId);
  await notifyOnStateTransition({
    previousProfile,
    currentProfile: profile,
    userEmail: user?.email ?? customerEmail ?? null,
    eventType,
  });
}

async function handleCheckoutCompleted(event) {
  const session = event.data.object;
  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id;
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;
  const userId = session.metadata?.app_user_id ?? null;

  if (!userId) {
    console.warn("checkout.session.completed missing app_user_id metadata.");
    return;
  }

  const previousProfile = await getBillingProfileByUserId(userId);
  await upsertBillingProfile(userId, {
    stripe_customer_id:
      customerId ?? previousProfile?.stripe_customer_id ?? null,
  });

  if (subscriptionId) {
    const stripe = getStripeServerClient();
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    await syncFromSubscription({
      subscription,
      userIdHint: userId,
      eventType: event.type,
    });
  }
}

async function handleCustomerUpdated(event) {
  const customer = event.data.object;
  const customerId = customer.id;
  const normalizedEmail = normalizeEmail(customer.email);

  if (!customerId || !normalizedEmail) return;

  const profile = await getBillingProfileByCustomerId(customerId);
  if (!profile?.user_id) return;

  await updateUserById(profile.user_id, { email: normalizedEmail });
}

export async function POST(request) {
  try {
    const signature = request.headers.get("stripe-signature");
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!signature || !webhookSecret) {
      return NextResponse.json(
        { error: "Webhook is not configured." },
        { status: 400 },
      );
    }

    const payload = await request.text();
    const stripe = getStripeServerClient();
    const event = stripe.webhooks.constructEvent(
      payload,
      signature,
      webhookSecret,
    );

    console.log(`Processing webhook event: ${event.type}`);

    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        await syncFromSubscription({
          subscription,
          userIdHint: subscription?.metadata?.app_user_id ?? null,
          eventType: event.type,
        });
        break;
      }
      case "invoice.paid":
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const subscriptionId =
          typeof invoice.subscription === "string"
            ? invoice.subscription
            : invoice.subscription?.id;
        if (subscriptionId) {
          const subscription =
            await stripe.subscriptions.retrieve(subscriptionId);
          await syncFromSubscription({
            subscription,
            userIdHint: subscription?.metadata?.app_user_id ?? null,
            eventType: event.type,
          });
        }
        break;
      }
      case "customer.updated":
        await handleCustomerUpdated(event);
        break;
      default:
        break;
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("POST /api/stripe/webhook error:", error);
    return NextResponse.json({ error: "Webhook failed." }, { status: 400 });
  }
}
