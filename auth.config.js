import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { verifyPassword } from "@/lib/password";

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
      .select("id, email, name, image, password_hash")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (error) {
      console.error("Failed to fetch app user by email:", error);
      return null;
    }

    return data;
  } catch (error) {
    console.error("Failed to connect to Supabase while fetching app user:", error);
    return null;
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
      .select("id, email, name, image")
      .single();

    if (error) {
      console.error("Failed to upsert OAuth user:", error);
      return null;
    }

    return data;
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
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (session?.user && token?.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
  },
};

