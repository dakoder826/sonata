import Link from "next/link";

export default function BillingSuccessPage() {
  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-16 text-neutral-100 md:px-6">
      <div className="mx-auto max-w-2xl rounded-3xl border border-emerald-400/30 bg-emerald-500/10 p-8">
        <p className="text-xs font-semibold tracking-[0.2em] text-emerald-200 uppercase">
          Billing updated
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
          Welcome to Sonata Pro
        </h1>
        <p className="mt-4 text-sm text-emerald-50/90">
          Your upgrade is processing. If your plan badge does not update
          immediately, refresh in a few seconds while Stripe webhooks sync your
          account.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/sheets"
            className="rounded-full border border-white/40 px-4 py-2 text-sm font-medium text-white transition hover:border-white hover:bg-white/10"
          >
            Go to your sheets
          </Link>
        </div>
      </div>
    </main>
  );
}
