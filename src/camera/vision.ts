// One cheap vision call on a JPEG. Prefers the Anthropic API directly
// (ANTHROPIC_API_KEY); falls back to the Vercel AI Gateway's OpenAI-compatible
// endpoint (AI_GATEWAY_API_KEY). Raw fetch — this worker stays zero-dep.

const TIMEOUT_MS = 45_000;

export function visionConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.AI_GATEWAY_API_KEY);
}

export async function describeImage(jpeg: Buffer, prompt: string): Promise<string> {
  const b64 = jpeg.toString("base64");
  if (process.env.ANTHROPIC_API_KEY) return anthropicDirect(b64, prompt);
  if (process.env.AI_GATEWAY_API_KEY) return viaGateway(b64, prompt);
  throw new Error("Set ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY for camera vision.");
}

async function anthropicDirect(b64: string, prompt: string): Promise<string> {
  const model = process.env.VISION_MODEL ?? "claude-haiku-4-5";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY as string,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = json.content?.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Anthropic reply had no text content");
  return text;
}

async function viaGateway(b64: string, prompt: string): Promise<string> {
  const model = process.env.VISION_MODEL ?? "anthropic/claude-haiku-4.5";
  const res = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`AI Gateway ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("AI Gateway reply had no text content");
  return text;
}
