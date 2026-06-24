// Send a Telegram message directly via the Bot API (same bot as the agent).

export async function notify(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.OWNER_TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Set TELEGRAM_BOT_TOKEN and OWNER_TELEGRAM_CHAT_ID.");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}
