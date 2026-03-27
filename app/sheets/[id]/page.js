import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authConfig } from "@/auth.config";
import SheetPlaybackPanel from "@/components/SheetPlaybackPanel";
import { createSupabaseServerClient } from "@/lib/supabaseServer";

export default async function SheetDetailPage({ params: paramsPromise }) {
  const { id } = await paramsPromise;
  const session = await getServerSession(authConfig);
  const userId = session?.user?.id ?? null;

  if (!userId) {
    redirect(`/signin?callbackUrl=/sheets/${id}`);
  }

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("transcriptions")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("Failed to load sheet detail:", {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    });
  }

  if (!data) {
    notFound();
  }

  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-8 text-neutral-100 md:px-6 md:py-10">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs tracking-[0.2em] text-neutral-500 uppercase">
            Piano sheet detail
          </p>
          <Link
            href="/sheets"
            className="rounded-full border border-white/20 px-4 py-2 text-sm text-neutral-200 transition hover:border-white/40 hover:bg-white/5"
          >
            Back to all sheets
          </Link>
        </div>

        <section className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-neutral-950">
          <SheetPlaybackPanel
            title="Sheet playback"
            songUrl={data.song_url}
            createdAt={data.created_at}
            midiUrl={data.midi_url}
            rawMidiUrl={data.raw_midi_url}
            pdfUrl={data.pdf_url}
            timeSignature={data.time_signature || "4/4"}
          />
        </section>
      </div>
    </main>
  );
}
