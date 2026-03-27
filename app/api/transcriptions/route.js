import { getServerSession } from "next-auth";
import { authConfig } from "@/auth.config";
import { createSupabaseServerClient } from "@/lib/supabaseServer";

export async function GET() {
  try {
    const session = await getServerSession(authConfig);
    const userId = session?.user?.id ?? null;

    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      });
    }

    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase
      .from("transcriptions")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching transcriptions:", error);
      return new Response(
        JSON.stringify({ error: "Failed to load saved piano sheets." }),
        {
          status: 500,
        },
      );
    }

    return new Response(JSON.stringify({ items: data ?? [] }), { status: 200 });
  } catch (error) {
    console.error("GET /api/transcriptions error:", error);
    return new Response(JSON.stringify({ error: "Something went wrong." }), {
      status: 500,
    });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { songUrl, cleanLevel } = body || {};

    if (!songUrl || typeof songUrl !== "string") {
      return new Response(JSON.stringify({ error: "songUrl is required" }), {
        status: 400,
      });
    }

    if (
      cleanLevel != null &&
      cleanLevel !== "" &&
      cleanLevel !== "simple" &&
      cleanLevel !== "regular"
    ) {
      return new Response(
        JSON.stringify({
          error: "cleanLevel must be 'simple' or 'regular'.",
        }),
        { status: 400 },
      );
    }

    const session = await getServerSession(authConfig);
    const userId = session?.user?.id ?? null;

    let transcriptionId = null;
    const supabase = userId ? createSupabaseServerClient() : null;

    if (userId) {
      try {
        const { data, error } = await supabase
          .from("transcriptions")
          .insert({
            user_id: userId,
            song_url: songUrl,
            clean_level: cleanLevel === "simple" ? "simple" : "regular",
            status: "processing",
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

    // Call transcription microservice (Basic Pitch + pretty_midi cleanup)
    const rawServiceUrl = process.env.TRANSCRIBER_URL;
    // Common dev misconfig: service listens on 0.0.0.0, but the browser cannot
    // reliably reach http://0.0.0.0:PORT. Normalize to localhost.
    const serviceUrl =
      (rawServiceUrl ?? "")
        .trim()
        .replace(/^http:\/\/0\.0\.0\.0:/i, "http://127.0.0.1:")
        .replace(/^https:\/\/0\.0\.0\.0:/i, "https://127.0.0.1:")
        .trim() || "http://127.0.0.1:8000";

    if (!serviceUrl) {
      console.error("TRANSCRIBER_URL is not configured.");
      return new Response(
        JSON.stringify({
          error:
            "Transcription service is not configured. Please try again later.",
        }),
        { status: 500 },
      );
    }

    console.log("Using transcriber service URL:", serviceUrl);

    const serviceResponse = await fetch(
      `${serviceUrl.replace(/\/$/, "")}/transcribe`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          audio_url: songUrl,
          use_separation: true,
          // Two user-facing modes:
          // - simple -> simple cleanup profile
          // - regular -> balanced cleanup profile
          clean_level: cleanLevel === "simple" ? "simple" : "balanced",
        }),
      },
    );

    if (!serviceResponse.ok) {
      const data = await serviceResponse.json().catch(() => null);
      console.error(
        "Transcriber service error:",
        data || serviceResponse.status,
      );

      if (userId && transcriptionId) {
        await supabase
          .from("transcriptions")
          .update({
            status: "failed",
            error_message:
              data?.error ||
              data?.detail ||
              "Failed to generate sheet from this song URL.",
          })
          .eq("id", transcriptionId)
          .eq("user_id", userId);
      }

      return new Response(
        JSON.stringify({
          error:
            data?.error ||
            data?.detail ||
            "We couldn't generate a MIDI file from this link. Please try a different song or try again later.",
        }),
        { status: 502 },
      );
    }

    const serviceData = await serviceResponse.json().catch(() => null);

    if (!serviceData?.midi_url) {
      console.error("Transcriber service returned no midi_url:", serviceData);

      if (userId && transcriptionId) {
        await supabase
          .from("transcriptions")
          .update({
            status: "failed",
            error_message:
              "Transcription service did not return a generated file.",
          })
          .eq("id", transcriptionId)
          .eq("user_id", userId);
      }

      return new Response(
        JSON.stringify({
          error:
            "Transcription service did not return a MIDI file. Please try again later.",
        }),
        { status: 502 },
      );
    }

    const result = {
      id: transcriptionId || "external-" + Date.now().toString(),
      songUrl,
      midiUrl: serviceData.midi_url,
      rawMidiUrl: serviceData.raw_midi_url ?? null,
      pdfUrl: serviceData.pdf_url ?? null,
      timeSignature: serviceData.time_signature ?? "4/4",
    };

    if (userId && transcriptionId) {
      const { error: updateError } = await supabase
        .from("transcriptions")
        .update({
          midi_url: result.midiUrl,
          raw_midi_url: result.rawMidiUrl,
          pdf_url: result.pdfUrl,
          time_signature: result.timeSignature,
          clean_level: cleanLevel === "simple" ? "simple" : "regular",
          status: "completed",
          error_message: null,
        })
        .eq("id", transcriptionId)
        .eq("user_id", userId);

      if (updateError) {
        console.error("Failed to update transcription record:", updateError);
      }
    }

    return new Response(JSON.stringify(result), { status: 200 });
  } catch (error) {
    console.error("POST /api/transcriptions error:", error);
    return new Response(JSON.stringify({ error: "Something went wrong." }), {
      status: 500,
    });
  }
}
