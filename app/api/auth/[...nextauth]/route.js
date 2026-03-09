import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

const authHandler = NextAuth(authConfig);

export const GET = authHandler;
export const POST = authHandler;

