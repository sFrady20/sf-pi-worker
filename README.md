# sf-pi-worker

An always-on home worker for [sf-agent](https://github.com/sFrady20/sf-agent). It
runs long-lived and delayed jobs that the agent's serverless functions (on Vercel)
can't hold — starting with short-fuse reminders ("remind me in 55 minutes…").

The agent reaches it over **Tailscale Funnel** (a stable public HTTPS URL that
tunnels to this worker), guarded by a shared secret. The worker does the waiting
and pings you on Telegram when a job fires.

```
sf-agent (Vercel)  --HTTPS+secret-->  Tailscale Funnel  -->  this worker (Pi)  -->  Telegram
```

## Job API

All `/jobs` routes are bearer-authed (`Authorization: Bearer $WORKER_SECRET`).

- `GET /health` → `{ "ok": true }`
- `POST /jobs` — schedule a job:
  ```json
  { "type": "reminder", "message": "go to the grocery store", "delaySeconds": 3300 }
  ```
  → `{ "id": "...", "fireAt": "2026-06-24T18:55:00.000Z" }`
  (or `{ "type": "presence", "message": "...", "trigger": "home" | "away" }`)
- `GET /jobs` → `{ "timed": [...], "presence": [...] }` — everything pending, with ids.
- `DELETE /jobs/<id>` — cancel a pending timed or presence reminder.

Pending jobs persist to `data/jobs.json`, so they survive a restart. If Telegram
is unreachable when a reminder fires, delivery retries every minute until it
lands — a reminder is never silently dropped. Add new job types in the `Job`
union and the `fire` switch in `src/jobs.ts`.

> Security: the worker only does typed jobs — no arbitrary shell execution — and
> requires the bearer secret on every call. Keep `WORKER_SECRET` long and private.

## Run it on the Pi

Install [bun](https://bun.sh) (runs TypeScript directly, ARM-native):

```bash
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/sFrady20/sf-pi-worker && cd sf-pi-worker
cp .env.example .env && nano .env        # set WORKER_SECRET, TELEGRAM_BOT_TOKEN, OWNER_TELEGRAM_CHAT_ID
bun src/index.ts                          # starts on :8088
```

Keep it running with systemd (see [`deploy/sf-pi-worker.service`](deploy/sf-pi-worker.service)):

```bash
sudo cp deploy/sf-pi-worker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sf-pi-worker
```

## Expose it with Tailscale Funnel

1. Install Tailscale and join your tailnet:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
2. In the [Tailscale admin](https://login.tailscale.com/admin/dns), enable
   **MagicDNS** and **HTTPS certificates** for your tailnet.
3. Allow Funnel for this node (admin → Access controls → add the `funnel`
   attribute, or follow the link `tailscale funnel` prints the first time).
4. Publish the worker's port:
   ```bash
   sudo tailscale funnel --bg 8088
   tailscale funnel status        # shows your public https://<pi>.<tailnet>.ts.net URL
   ```
5. Put that URL in the agent's `PI_WORKER_URL` and the same secret in
   `PI_WORKER_SECRET`. Test:
   ```bash
   curl https://<pi>.<tailnet>.ts.net/health
   ```

## Mood lighting (LIFX)

An optional cooperative lighting daemon (`src/lighting/`) that makes the lab feel
alive without fighting you. It controls LIFX bulbs over the LAN.

- **Time-of-day scenes** (morning / day / evening / night), all color-first; night
  is a dim calming indigo, not off. Morning and evening are *authoritative* — they
  may turn lights on/off and reclaim bulbs you'd changed by hand. Daytime is
  cooperative.
- **Held themes.** An explicit theme (designed by the agent, or a named scene
  applied on demand) *holds* — the schedule won't revert it — until you resume auto,
  change a bulb by hand, or the next authoritative time-window.
- **Cooperative ownership.** It tracks what it set each bulb to; if you change one
  by hand it backs off that bulb until the next authoritative scene.
- **Gentle drift.** Owned color bulbs wander hue slowly, skipping avoided colors.
- **Party mode.** `POST /lighting/party {intensity?,palette?,brightness?}` takes over
  **every** light (hand-overridden ones included) with fast color changes and
  occasional white flashes — intensity 1 (chill) to 10 (rave) sets tempo and flash
  odds; omit the palette for full spectrum (taste hue limits don't apply). It
  snapshots each light first and `POST /lighting/party/stop` restores that exact
  state. The snapshot persists (`data/party-state.json`), so a worker restart
  mid-party resumes the party. Posting `/lighting/party` again retunes it in place.
- **Taste** lives in `data/lighting.json` (auto-created): `avoidHueRanges` (red by
  default), `perLight` brightness multipliers / exclusions, drift speed, and the
  scene schedule. Edit it directly or via the API.

It's optional — the worker runs reminders without it (`lifx-lan-client` loads
lazily; if it's missing or fails, lighting is simply disabled). A held theme, the
active scene, and hand-overridden bulbs persist to `data/lighting-state.json`, so
a worker restart doesn't revert your lighting.

Endpoints (all bearer-authed): `GET /lighting` ·
`POST /lighting/theme {palette,brightness,drift,white?}` · `POST /lighting/auto` ·
`POST /lighting/party {intensity?,palette?,brightness?}` · `POST /lighting/party/stop` ·
`POST /lighting/scene {scene}` · `POST /lighting/power {on}` · `POST /lighting/flash` ·
`POST /lighting/enable {enabled}` · `POST /lighting/tune {light?,brightnessScale?,exclude?,avoidRed?}`.

> `src/lighting/lifx.ts` wraps the LAN library — verify its calls against your
> installed `lifx-lan-client` version, and add per-light tuning once you see your
> bulbs' labels in `GET /lighting`.

**Discovery troubleshooting.** `LIFX Client stopped sending due to unbound socket`
means the library's UDP socket hit an error and closed — it never rebinds on its
own. The worker now detects this and rebuilds the client automatically (with
backoff), so lights recover within seconds. If the error is constant (often with
high CPU), broadcast discovery is leaving the wrong interface — usually
**Tailscale**. Set `LIFX_ADDRESS` to the Pi's LAN IP and `LIFX_BROADCAST` to your
subnet broadcast (e.g. `192.168.1.255`). If it persists, set `LIFX_LIGHTS` to
your bulbs' IPs to skip broadcast discovery entirely.

## Parking camera (Wyze via docker-wyze-bridge)

The worker can grab still frames from a Wyze cam and answer "is a parking spot
open?" with one cheap vision call (Claude Haiku). The camera is reached through
[docker-wyze-bridge](https://github.com/mrlt8/docker-wyze-bridge) (unofficial;
needs a free API key/id from [Wyze's developer portal](https://developer-api-console.wyze.com/#/apikey/view)):

```bash
cd deploy
WYZE_EMAIL=... WYZE_PASSWORD=... WYZE_API_ID=... WYZE_API_KEY=... \
  docker compose -f wyze-bridge.compose.yml up -d
# camera names appear in the bridge UI at http://<pi>:5000
```

Set `WYZE_BRIDGE_URL`, `PARKING_CAMERA`, a vision key (`ANTHROPIC_API_KEY` or
`AI_GATEWAY_API_KEY`), and optionally `PARKING_PROMPT` describing which spots
matter (e.g. "the two curb spots in front of the house").

Endpoints (all bearer-authed):

- `GET /camera/snapshot` → the latest JPEG frame (debugging / on-demand vision).
- `GET /camera/parking` → `{ configured, last, watch }`.
- `POST /camera/parking/check` → grab a frame, run the vision model, return
  `{ open, total, detail, at }`. Takes ~10-30s — use a generous client timeout.
- `POST /camera/parking/watch { minutes?, intervalSeconds?, stopWhenOpen? }` →
  re-check on an interval (defaults: 60 min window, every 120s, stop after the
  first open spot) and **ping Telegram the moment a spot opens**. Checks chain
  (never overlap); 3 straight failures stop the watch with a Telegram note, and
  an expired window says nothing opened. Watches are in-memory — a restart ends them.
- `DELETE /camera/parking/watch` → stop.

The agent's `check_parking` / `watch_parking` tools drive these.

**Troubleshooting.** A camera or vision failure returns `502` with the real
reason in `{ "error": ... }` — read it before assuming the worker is down. The
usual cause is docker-wyze-bridge being stopped or logged out, which the Wyze
phone app does *not* reveal (the app talks to Wyze's cloud; the bridge is a
separate local login). Check the bridge directly on the Pi:

```bash
docker ps | grep wyze            # is the container up?
curl -sS -o /dev/null -w '%{http_code}\n' "$WYZE_BRIDGE_URL/snapshot/$PARKING_CAMERA.jpg?api=$WYZE_BRIDGE_API_KEY"
docker logs --tail 50 wyze-bridge
```

An empty-bodied `502` with no worker log line is different: that is Tailscale
Funnel reporting a dropped connection, i.e. the worker process died mid-request.

## Discord gateway listener

The agent (serverless) can only receive slash commands; *reading* Discord takes
a persistent Gateway WebSocket with the privileged **Message Content intent** —
so this worker holds it (`src/discord/gateway.ts`, zero-dep). It watches server
messages + DMs (bots skipped), buffers them, and forwards a batch every
`DISCORD_BATCH_SECONDS` (default 60) to the agent's ingest endpoint, where a
cheap triage pass files tasks/facts/reminders and pings Steven only when needed.

Setup:

1. Discord Developer Portal → your app → **Bot → Privileged Gateway Intents →
   enable "Message Content Intent"** (otherwise the gateway closes with 4014 and
   the worker logs an actionable error).
2. Set `DISCORD_BOT_TOKEN` (same bot as the agent), `AGENT_DISCORD_URL`
   (`https://<vercel-app>/eve/v1/discord/ingest`), and `DISCORD_AGENT_SECRET`
   (= the agent's `DISCORD_INGEST_SECRET`).
3. Optional: `DISCORD_WATCH_CHANNELS` (comma-separated channel ids) to limit
   which guild channels are ingested; DMs always pass.

The client handles hello/identify, heartbeats (with zombie detection), resume
on drops, and exponential backoff. Failed forwards are retried on the next
flush (buffer capped at 200 messages, oldest dropped). The agent dedupes by
batch id, so a retry never double-processes.

## Presence ("am I home?")

Watches one phone's MAC on the LAN with `ip monitor neigh` (event-driven, no
polling) and fires a home/away transition:

- **Arrivals are instant.** Departures are debounced — phones sleep WiFi, so it
  waits `PRESENCE_AWAY_GRACE_SECONDS` and pings before declaring you away.
- On a transition it fires any pending presence reminders to Telegram and POSTs to
  the agent (`AGENT_PRESENCE_URL`) so it records your home/away status.
- Set `PRESENCE_MAC` to your phone's MAC on the home network — **disable MAC
  randomization for that network** so it's stable.

Register a presence reminder (the agent's `remind_when` tool does this):

```json
POST /jobs  { "type": "presence", "message": "take out the trash", "trigger": "home" }
```

`ip monitor neigh` and `ping` run without root. If your distro restricts the
neighbor table, grant the service `CAP_NET_ADMIN`.

## Local development

```bash
bun install        # only dev deps (types + tsc); zero runtime deps
bun run typecheck
bun src/index.ts
```
