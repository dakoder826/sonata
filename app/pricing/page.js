import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authConfig } from "@/auth.config";
import PricingPlans from "@/components/PricingPlans";

export default async function PricingPage() {
  const session = await getServerSession(authConfig);

  if (!session?.user?.id) {
    redirect("/signin?callbackUrl=/pricing");
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <PricingPlans id="pricing" freeCtaHref="/sheets" proCtaHref="/sheets" />
    </main>
  );
}
