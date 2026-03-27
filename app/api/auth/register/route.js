import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { hashPassword } from "@/lib/password";

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function POST(request) {
  try {
    const body = await request.json();
    const email = normalizeEmail(body?.email);
    const password = typeof body?.password === "string" ? body.password : "";
    const name = typeof body?.name === "string" ? body.name.trim() : "";

    if (!isValidEmail(email)) {
      return NextResponse.json(
        { error: "Please provide a valid email address." },
        { status: 400 },
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters long." },
        { status: 400 },
      );
    }

    const supabase = createSupabaseServerClient();

    const { data: existingUser, error: existingUserError } = await supabase
      .from("users")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (existingUserError) {
      console.error("Failed to check existing app user:", existingUserError);
      return NextResponse.json(
        { error: "Could not create account right now. Please try again." },
        { status: 500 },
      );
    }

    if (existingUser) {
      return NextResponse.json(
        { error: "An account with this email already exists." },
        { status: 409 },
      );
    }

    const passwordHash = await hashPassword(password);

    const { data: newUser, error: createUserError } = await supabase
      .from("users")
      .insert({
        email,
        name: name || null,
        password_hash: passwordHash,
        auth_provider: "email",
      })
      .select("id, email, name")
      .single();

    if (createUserError) {
      console.error("Failed to create app user:", createUserError);
      return NextResponse.json(
        { error: "Could not create account right now. Please try again." },
        { status: 500 },
      );
    }

    return NextResponse.json({ user: newUser }, { status: 201 });
  } catch (error) {
    console.error("POST /api/auth/register error:", error);
    return NextResponse.json(
      { error: "Could not create account right now. Please try again." },
      { status: 500 },
    );
  }
}
