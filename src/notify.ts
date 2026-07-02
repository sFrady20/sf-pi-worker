// Send a Telegram message directly via the Bot API (same bot as the agent).
// Hard timeout so a hung request can't wedge a job; long text is chunked to
// Telegram's 4096-char limit.

const MAX_LEN = 4096;
const TIMEOUT_MS = 10_000;

function chunks(text: string): string[] {
  if (text.length <= MAX_LEN) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > MAX_LEN) {
    const cut = rest.lastIndexOf("\n", MAX_LEN);
    const at = cut > MAX_LEN / 2 ? cut : MAX_LEN;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

export async function notify(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.OWNER_TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Set TELEGRAM_BOT_TOKEN and OWNER_TELEGRAM_CHAT_ID.");
  for (const part of chunks(text)) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: part }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
  }
}
