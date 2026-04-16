import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authConfig } from "@/auth.config";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { getStripeServerClient } from "@/lib/stripe";

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
    const { data: billingProfile, error: profileError } = await supabase
      .from("billing_profiles")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (profileError) {
      console.error("Failed to load billing profile for portal:", profileError);
      return NextResponse.json(
        { error: "Could not open billing portal right now." },
        { status: 500 },
      );
    }

    if (!billingProfile?.stripe_customer_id) {
      return NextResponse.json(
        {
          error: "No billing profile found. Start with an upgrade checkout first.",
          code: "missing_customer",
        },
        { status: 400 },
      );
    }

    const stripe = getStripeServerClient();
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: billingProfile.stripe_customer_id,
      return_url: `${getBaseUrl()}/sheets`,
    });

    return NextResponse.json({ url: portalSession.url });
  } catch (error) {
    console.error("POST /api/billing/portal error:", error);
    return NextResponse.json(
      { error: "Could not open billing portal right now." },
      { status: 500 },
    );
  }
}
