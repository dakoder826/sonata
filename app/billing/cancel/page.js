import Link from "next/link";

export default function BillingCancelPage() {
  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-16 text-neutral-100 md:px-6">
      <div className="mx-auto max-w-2xl rounded-3xl border border-white/15 bg-neutral-900/70 p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-400">
          Checkout canceled
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
          No changes were made
        </h1>
        <p className="mt-4 text-sm text-neutral-300">
          You can keep using the free plan and upgrade whenever you are ready.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/sheets"
            className="rounded-full border border-white/40 px-4 py-2 text-sm font-medium text-white transition hover:border-white hover:bg-white/10"
          >
            Back to sheets
          </Link>
        </div>
      </div>
    </main>
  );
}
