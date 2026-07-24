// Still frames from docker-wyze-bridge on the LAN. The bridge exposes each
// camera's latest frame as /snapshot/<cam-name>.jpg (see deploy/wyze-bridge).

const TIMEOUT_MS = 20_000;

export function cameraConfigured(): boolean {
  return Boolean(process.env.WYZE_BRIDGE_URL && process.env.PARKING_CAMERA);
}

export async function getSnapshot(camera?: string): Promise<Buffer> {
  const base = process.env.WYZE_BRIDGE_URL;
  const cam = camera ?? process.env.PARKING_CAMERA;
  if (!base || !cam) throw new Error("Set WYZE_BRIDGE_URL and PARKING_CAMERA.");
  const key = process.env.WYZE_BRIDGE_API_KEY;
  const url =
    `${base.replace(/\/$/, "")}/snapshot/${encodeURIComponent(cam)}.jpg` +
    (key ? `?api=${encodeURIComponent(key)}` : "");
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`wyze-bridge snapshot ${res.status}: ${await res.text()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // A real frame is tens of KB; a stub/error page is not.
  if (buf.length < 1024) throw new Error("wyze-bridge returned an implausibly small image");
  return buf;
}
