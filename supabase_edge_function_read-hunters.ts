const corsHeaders = {
  "Access-Control-Allow-Origin": "https://okitakenji.github.io",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "POST only" }, 405);
  }

  const origin = req.headers.get("origin") || "";
  if (origin && origin !== "https://okitakenji.github.io") {
    return json({ error: "Origin not allowed" }, 403);
  }

  try {
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return json({ error: "OPENAI_API_KEY is not configured in Supabase" }, 500);
    }

    const body = await req.json();
    const image = String(body?.image || "");

    if (!image.startsWith("data:image/")) {
      return json({ error: "image data URL is required" }, 400);
    }

    if (image.length > 12_000_000) {
      return json({ error: "image payload is too large" }, 413);
    }

    const prompt = [
      "Exact transcription task for Monster Hunter: World Iceborne.",
      "The image is a contact sheet of member-list rows. Each row has a cyan row number at far left.",
      "Read rows 2 through 15.",
      "For each row, transcribe ONLY:",
      "1) hunter name from the name field on the left",
      "2) online ID from the online-ID field on the right",
      "",
      "Rules:",
      "- Preserve the hunter name exactly, including Japanese, Greek letters, kaomoji, brackets, symbols and punctuation.",
      "- Preserve online ID capitalization, digits, underscores, periods and hyphens exactly.",
      "- Characters 0/O/o, 1/I/l, 8/B are different. Inspect them carefully; never normalize them.",
      "- Do not copy MR/HR numbers into either field.",
      "- Do not infer or invent unreadable characters.",
      "- If a field truly cannot be read, return an empty string and low confidence.",
      "- Return exactly one object for each row 2 through 15, in ascending row order."
    ].join("\\n");

    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        members: {
          type: "array",
          minItems: 14,
          maxItems: 14,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              row: { type: "integer", minimum: 2, maximum: 15 },
              name: { type: "string" },
              id: { type: "string" },
              name_confidence: { type: "integer", minimum: 0, maximum: 100 },
              id_confidence: { type: "integer", minimum: 0, maximum: 100 }
            },
            required: ["row", "name", "id", "name_confidence", "id_confidence"]
          }
        }
      },
      required: ["members"]
    };

    const openaiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: Deno.env.get("OPENAI_MODEL") || "gpt-5.6-sol",
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            {
              type: "input_image",
              image_url: image,
              detail: "original"
            }
          ]
        }],
        text: {
          format: {
            type: "json_schema",
            name: "iceborne_member_list",
            strict: true,
            schema
          }
        }
      }),
    });

    const data = await openaiRes.json();

    if (!openaiRes.ok) {
      console.error("OpenAI error", data);
      return json({
        error: data?.error?.message || "OpenAI request failed"
      }, 502);
    }

    let outputText = "";
    for (const item of data?.output || []) {
      if (item?.type !== "message") continue;
      for (const part of item?.content || []) {
        if (part?.type === "output_text" && typeof part.text === "string") {
          outputText += part.text;
        }
      }
    }

    if (!outputText) {
      return json({ error: "AI returned no structured text" }, 502);
    }

    const parsed = JSON.parse(outputText);
    const members = Array.isArray(parsed?.members) ? parsed.members : [];
    members.sort((a, b) => Number(a.row) - Number(b.row));

    if (members.length !== 14) {
      return json({ error: "AI did not return all 14 rows" }, 502);
    }

    return json({ members });
  } catch (err) {
    console.error(err);
    return json({ error: err?.message || String(err) }, 500);
  }
});
