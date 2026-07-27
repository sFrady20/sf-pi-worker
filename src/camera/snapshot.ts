// Still frames from the wyze-bridge container on the LAN (see deploy/).
//
// Endpoint is `GET <base>/api/snapshot/<cam>` — no .jpg suffix, port 5080. The
// older mrlt8 image used /snapshot/<cam>.jpg on :5000 with an ?api= key; this is
// the IDisposable fork, which authenticates with BRIDGE_AUTH instead (we run
// LAN-only with it off, so no credentials here). Camera names use underscores.

const TIMEOUT_MS = 20_000;

export function cameraConfigured(): boolean {
  return Boolean(process.env.WYZE_BRIDGE_URL && process.env.PARKING_CAMERA);
}

export async function getSnapshot(camera?: string): Promise<Buffer> {
  const base = process.env.WYZE_BRIDGE_URL;
  const cam = camera ?? process.env.PARKING_CAMERA;
  if (!base || !cam) throw new Error("Set WYZE_BRIDGE_URL and PARKING_CAMERA.");
  const url = `${base.replace(/\/$/, "")}/api/snapshot/${encodeURIComponent(cam)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`wyze-bridge snapshot ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // A real frame is tens of KB; a stub/error page is not.
  if (buf.length < 1024) throw new Error("wyze-bridge returned an implausibly small image");
  // Insist on actual JPEG bytes. The bridge has a habit of answering 200 with
  // something else (a placeholder SVG, a JSON error) when a camera has no frame
  // yet — better to say so than to hand the vision model garbage.
  if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) {
    throw new Error(`wyze-bridge returned ${buf.length} bytes that are not a JPEG (camera '${cam}' may have no frame yet)`);
  }
  return buf;
}
