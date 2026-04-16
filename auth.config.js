import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { verifyPassword } from "@/lib/password";
import { normalizePlanTier } from "@/lib/billing";

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

async function getAppUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  try {
    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase
      .from("users")
      .select("id, email, name, image, password_hash, plan_tier, last_seen")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (error) {
      console.error("Failed to fetch app user by email:", error);
      return null;
    }

    if (!data?.id) return data;
    const billingProfile = await getBillingProfileByUserId(data.id);
    return {
      ...data,
      subscription_status: billingProfile?.subscription_status ?? null,
      subscription_current_period_end:
        billingProfile?.subscription_current_period_end ?? null,
      cancel_at: billingProfile?.cancel_at ?? null,
      past_due_display_tier: billingProfile?.past_due_display_tier ?? null,
    };
  } catch (error) {
    console.error("Failed to connect to Supabase while fetching app user:", error);
    return null;
  }
}

async function getAppUserById(userId) {
  if (!userId) return null;

  try {
    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase
      .from("users")
      .select("id, email, name, image, password_hash, plan_tier, last_seen")
      .eq("id", userId)
      .maybeSingle();

    if (error) {
      console.error("Failed to fetch app user by id:", error);
      return null;
    }

    if (!data?.id) return data;
    const billingProfile = await getBillingProfileByUserId(data.id);
    return {
      ...data,
      subscription_status: billingProfile?.subscription_status ?? null,
      subscription_current_period_end:
        billingProfile?.subscription_current_period_end ?? null,
      cancel_at: billingProfile?.cancel_at ?? null,
      past_due_display_tier: billingProfile?.past_due_display_tier ?? null,
    };
  } catch (error) {
    console.error("Failed to connect to Supabase while fetching app user:", error);
    return null;
  }
}

async function getBillingProfileByUserId(userId) {
  if (!userId) return null;

  try {
    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase
      .from("billing_profiles")
      .select(
        "subscription_status, subscription_current_period_end, cancel_at, past_due_display_tier",
      )
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("Failed to fetch billing profile by user id:", error);
      return null;
    }

    return data ?? null;
  } catch (error) {
    console.error(
      "Failed to connect to Supabase while fetching billing profile:",
      error,
    );
    return null;
  }
}

async function touchLastSeen(userId) {
  if (!userId) return;

  try {
    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase
      .from("users")
      .select("last_seen")
      .eq("id", userId)
      .maybeSingle();

    if (error) {
      console.error("Failed to load last_seen value:", error);
      return;
    }

    const lastSeen = data?.last_seen ? new Date(data.last_seen).getTime() : null;
    const now = Date.now();
    const THIRTY_MINUTES = 30 * 60 * 1000;
    const shouldTouch =
      !Number.isFinite(lastSeen) || now - lastSeen >= THIRTY_MINUTES;
    if (!shouldTouch) return;

    const { error: updateError } = await supabase
      .from("users")
      .update({ last_seen: new Date(now).toISOString() })
      .eq("id", userId);

    if (updateError) {
      console.error("Failed to update last_seen:", updateError);
    }
  } catch (error) {
    console.error("Unexpected error updating last_seen:", error);
  }
}

async function upsertOAuthUser({ email, name, image, provider }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  try {
    const supabase = createSupabaseServerClient();
    const payload = {
      email: normalizedEmail,
      name: name ?? null,
      image: image ?? null,
      auth_provider: provider ?? "google",
    };

    const { data, error } = await supabase
      .from("users")
      .upsert(payload, { onConflict: "email" })
      .select("id, email, name, image, plan_tier, last_seen")
      .single();

    if (error) {
      console.error("Failed to upsert OAuth user:", error);
      return null;
    }

    if (!data?.id) return data;
    const billingProfile = await getBillingProfileByUserId(data.id);
    return {
      ...data,
      subscription_status: billingProfile?.subscription_status ?? null,
      subscription_current_period_end:
        billingProfile?.subscription_current_period_end ?? null,
      cancel_at: billingProfile?.cancel_at ?? null,
      past_due_display_tier: billingProfile?.past_due_display_tier ?? null,
    };
  } catch (error) {
    console.error("Failed to connect to Supabase while upserting user:", error);
    return null;
  }
}

export const authConfig = {
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
    Credentials({
      name: "Email",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = normalizeEmail(credentials?.email);
        const password =
          typeof credentials?.password === "string" ? credentials.password : "";

        if (!email || !password) return null;

        const appUser = await getAppUserByEmail(email);
        if (!appUser?.password_hash) return null;

        const isValid = await verifyPassword(password, appUser.password_hash);
        if (!isValid) return null;

        return {
          id: appUser.id,
          email: appUser.email,
          name: appUser.name,
          image: appUser.image,
          planTier: normalizePlanTier(appUser.plan_tier),
          subscriptionStatus: appUser.subscription_status ?? null,
          pastDueDisplayTier: appUser.past_due_display_tier ?? null,
          subscriptionCurrentPeriodEnd:
            appUser.subscription_current_period_end ?? null,
          cancelAt: appUser.cancel_at ?? null,
        };
      },
    }),
  ],
  pages: {
    signIn: "/signin",
  },
  callbacks: {
    async jwt({ token, user, account }) {
      if (user?.id) {
        token.sub = user.id;
        token.picture = user.image ?? token.picture;
        token.planTier = normalizePlanTier(user.planTier);
        token.subscriptionStatus = user.subscriptionStatus ?? null;
        token.pastDueDisplayTier = user.pastDueDisplayTier ?? null;
        token.subscriptionCurrentPeriodEnd =
          user.subscriptionCurrentPeriodEnd ?? null;
        token.cancelAt = user.cancelAt ?? null;
      }

      if (account?.provider === "google" && user?.email) {
        const appUser = await upsertOAuthUser({
          email: user.email,
          name: user.name,
          image: user.image,
          provider: "google",
        });

        if (appUser?.id) {
          token.sub = appUser.id;
          token.email = appUser.email;
          token.name = appUser.name ?? token.name;
          token.picture = appUser.image ?? token.picture;
          token.planTier = normalizePlanTier(appUser.plan_tier);
          token.subscriptionStatus = appUser.subscription_status ?? null;
          token.pastDueDisplayTier = appUser.past_due_display_tier ?? null;
          token.subscriptionCurrentPeriodEnd =
            appUser.subscription_current_period_end ?? null;
          token.cancelAt = appUser.cancel_at ?? null;
        }
      }

      if (token?.sub) {
        const appUser = await getAppUserById(token.sub);
        if (appUser?.id) {
          token.planTier = normalizePlanTier(appUser.plan_tier);
          token.subscriptionStatus = appUser.subscription_status ?? null;
          token.pastDueDisplayTier = appUser.past_due_display_tier ?? null;
          token.subscriptionCurrentPeriodEnd =
            appUser.subscription_current_period_end ?? null;
          token.cancelAt = appUser.cancel_at ?? null;
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (session?.user && token?.sub) {
        session.user.id = token.sub;
        session.user.image = token.picture ?? null;
        session.user.planTier = normalizePlanTier(token.planTier);
        session.user.subscriptionStatus = token.subscriptionStatus ?? null;
        session.user.pastDueDisplayTier = token.pastDueDisplayTier ?? null;
        session.user.subscriptionCurrentPeriodEnd =
          token.subscriptionCurrentPeriodEnd ?? null;
        session.user.cancelAt = token.cancelAt ?? null;
        await touchLastSeen(token.sub);
      }
      return session;
    },
  },
};

