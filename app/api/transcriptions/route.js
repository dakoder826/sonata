import { getServerSession } from "next-auth";
import { authConfig } from "@/auth.config";
import { createSupabaseServerClient } from "@/lib/supabaseServer";

export async function POST(request) {
  try {
    const body = await request.json();
    const { songUrl } = body || {};

    if (!songUrl || typeof songUrl !== "string") {
      return new Response(
        JSON.stringify({ error: "songUrl is required" }),
        { status: 400 }
      );
    }

    const session = await getServerSession(authConfig);
    const userId = session?.user?.id ?? null;

    let transcriptionId = null;

    if (userId) {
      try {
        const supabase = createSupabaseServerClient();
        const { data, error } = await supabase
          .from("transcriptions")
          .insert({
            user_id: userId,
            song_url: songUrl,
          })
          .select("id")
          .single();

        if (error) {
          console.error("Error inserting transcription:", error);
        } else {
          transcriptionId = data.id;
        }
      } catch (dbError) {
        console.error("Supabase insert failed:", dbError);
      }
    }

    // TODO: Replace this stub with a call to your Python AI service.
    // For now, return dummy URLs so the UI can be wired up end-to-end.
    const fakeId = transcriptionId || "demo-" + Date.now().toString();

    const result = {
      id: fakeId,
      songUrl,
      midiUrl: "https://example.com/fake-output.mid",
      pdfUrl: "https://example.com/fake-output.pdf",
    };

    return new Response(JSON.stringify(result), { status: 200 });
  } catch (error) {
    console.error("POST /api/transcriptions error:", error);
    return new Response(
      JSON.stringify({ error: "Something went wrong." }),
      { status: 500 }
    );
  }
}

