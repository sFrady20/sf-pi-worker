# sf-pi-worker

An always-on home worker for [sf-agent](https://github.com/sFrady20/sf-agent). It
runs long-lived and delayed jobs that the agent's serverless functions (on Vercel)
can't hold, and it **holds the agent's clock** — every recurring and scheduled
moment the agent owns.

The agent reaches it over **Tailscale Funnel** (a stable public HTTPS URL that
tunnels to this worker), guarded by a shared secret. The worker does the waiting;
when a moment arrives it either pings Telegram or calls the agent back to run a
full turn.

```
sf-agent (Vercel)  --HTTPS+secret-->  Tailscale Funnel  -->  this worker (Pi)  -->  Telegram
       ^                                                            |
       +-------------------- POST /eve/v1/wake ---------------------+
```

## The clock

Two shapes, both durable across a reboot.

**One-shot jobs** — fire once at a moment:

- `reminder` sends its text to Telegram verbatim.
- `wake` POSTs its prompt to the agent's `AGENT_WAKE_URL`, which runs a real agent
  turn with every tool and all of memory. The agent decides *then* what to do, and
  most wakes are expected to end without a message. If `AGENT_WAKE_URL` /
  `AGENT_WAKE_SECRET` aren't set, a wake degrades to a plain Telegram message
  rather than being lost.

**Recurring entries** (`src/crons.ts`, persisted to `data/crons.json`) — named,
minute-precise local times on chosen weekdays, edited by name. A box that has
never had a crons file is seeded once with a morning brief and an evening review;
after that the list belongs to the agent, and a deliberately emptied schedule
stays empty. A tick runs every 20s and will still fire an entry it missed by up to
10 minutes, so a busy box or a restart doesn't skip the day.

## Job API

All routes below are bearer-authed (`Authorization: Bearer $WORKER_SECRET`).

- `GET /health` → `{ "ok": true }`
- `POST /jobs` — schedule a one-shot. `delaySeconds` (relative) or `fireAt` (ISO):
  ```json
  { "type": "reminder", "message": "go to the grocery store", "delaySeconds": 3300 }
  { "type": "wake", "message": "Check whether the permit reply came in.", "fireAt": "2026-08-16T13:00:00Z", "key": "permit-followup" }
  { "type": "presence", "message": "take out the trash", "trigger": "home", "kind": "notify" }
  ```
  → `{ "id": "...", "type": "wake", "fireAt": "..." }`. An optional `key` makes the
  job idempotent: re-posting the same key re-times the pending job instead of
  stacking a duplicate.
- `GET /jobs` → `{ "timed": [...], "presence": [...], "recurring": {...} }` —
  everything on the clock, with ids and next runs.
- `DELETE /jobs/<id>` — cancel a pending one-shot by id, or by its `key`.
- `GET /crons` → the recurring entries with each one's next run.
- `PATCH /crons` — `{ replace?, remove?, upsert?, timezone? }`, applied in that
  order. Upsert patches by name (case-insensitive) or creates.
- `POST /crons/<name>/run` — fire one now, without waiting for its time.

Pending jobs persist to `data/jobs.json`, so they survive a restart. If delivery
fails (Telegram or the agent unreachable) it retries every minute — a duplicate
beats a loss — and is abandoned only once it's hours stale, since by then it isn't
the moment anymore. Add new job types in the `JobType` union and the `fire` switch
in `src/jobs.ts`.

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

- **Editable automation.** The default morning / day / evening / night entries are
  only a starting point. Entries can have arbitrary names, minute-precise local
  start times, selected weekdays, and `on` / `off` / `leave` power behavior.
  Reclaiming bulbs changed by hand and interrupting a held theme are independent
  per-entry choices, so an energy-saving off window does not require disabling the
  ambient system. A strict off window sets `power: "off"`, `reclaim: true`, and
  `interruptTheme: true`. Editing the active entry updates managed bulbs without
  pretending a clock boundary occurred; call `/lighting/auto` afterward when its
  reclaim/interruption policy should also apply immediately.
- **Held themes.** An explicit theme (designed by the agent, or a named scene
  applied on demand) *holds* — the schedule won't revert it — until you resume auto
  or an entry configured to interrupt the theme begins. A bulb changed by hand
  leaves the theme individually without ending it for the other bulbs.
- **Cooperative ownership.** It tracks what it set each bulb to; a physical or
  agent-requested hold makes it back off that bulb until a schedule entry configured
  to reclaim it begins, or the agent explicitly resumes automation.
- **Gentle drift.** Owned color bulbs wander hue slowly, skipping avoided colors.
- **Party mode.** `POST /lighting/party {intensity?,palette?,brightness?}` takes over
  every reachable, non-excluded light snapshotted at startup (hand-overridden ones
  included) with fast color changes and occasional white flashes. Intensity 1
  (chill) to 10 (rave) sets tempo and flash odds. Omit the initial palette for full
  spectrum; omission while retuning preserves the current palette, while `null`
  explicitly switches to full spectrum. `POST /lighting/party/stop` drains in-flight
  flashes and restores the exact snapshot. The snapshot persists
  (`data/party-state.json`), so a restart resumes either the party or an incomplete
  restoration safely.
- **Configuration** lives in `data/lighting.json` (auto-created): `avoidHueRanges`
  (red by default), per-light brightness multipliers / exclusions, drift speed,
  timezone, and the full schedule. Every field is readable and editable through
  the API; legacy `startHour` / `authoritative` configs migrate when loaded.
  If the persisted file cannot be validated, automation fails safe to disabled
  and status exposes the error/raw value. Repair starts with a complete schedule
  replacement, preventing a small patch from overwriting the old custom schedule.

It's optional — the worker runs reminders without it (`lifx-lan-client` loads
lazily; if it's missing or fails, lighting is simply disabled). A held theme, the
active scene, and hand-overridden bulbs persist to `data/lighting-state.json`, so
a worker restart doesn't revert your lighting. If that runtime-state file is
invalid, automatic control pauses instead of guessing; `GET /lighting` reports
`mode: "recovery_paused"` and a `stateIssue`, and an explicit auto resume or new
theme acknowledges recovery.

Primary endpoints (all bearer-authed):

- `GET /lighting` — live bulb states, active mode/effect, schedule, and config.
- `POST /lighting/control` — target every bulb or selected labels/ids; set raw
  power/HSBK/transition state and choose whether the result holds or follows auto.
- `PATCH /lighting/schedule` — replace, upsert, or remove validated schedule entries.
- `PATCH /lighting/config` — daemon timing/taste and per-light configuration.
- `POST /lighting/theme` / `POST /lighting/auto` — hold a (possibly drifting) look
  or explicitly resume automatic control.
- `POST /lighting/party` / `POST /lighting/party/stop` — start, retune, and exactly
  restore party mode; use `palette: null` to retune to full spectrum.
- `POST /lighting/scene` / `POST /lighting/flash` — apply a saved entry as a held
  theme or run a notification pulse.

The older `/lighting/scene-look`, `/lighting/power`, `/lighting/enable`, and
`/lighting/tune` mutation routes remain as compatibility adapters.

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

## Parking camera (Wyze via wyze-bridge)

The worker can grab still frames from a Wyze cam and answer "is a parking spot
open?" with one cheap vision call (Claude Haiku). The camera is reached through
the [IDisposable fork of docker-wyze-bridge](https://github.com/IDisposable/docker-wyze-bridge)
(unofficial; needs a free API key/id from [Wyze's developer portal](https://developer-api-console.wyze.com/#/apikey/view)).

**Use the fork, not [mrlt8/docker-wyze-bridge](https://github.com/mrlt8/docker-wyze-bridge).**
Wyze firmware disabled the TUTK P2P protocol the original depends on, so cameras
that still play fine in the Wyze app sit in an endless `[-13] IOTC_ER_TIMEOUT`
retry loop there, and that project is unmaintained. The fork is a Go rewrite that
promotes a camera to Wyze's WebRTC path after `TUTK_FALLBACK_THRESHOLD` (5)
consecutive TUTK failures.

This is a separate install step — the worker does **not** bring the bridge up,
and without it every parking check fails on connection-refused.

```bash
sudo apt install -y docker.io docker-compose   # Debian: no docker-compose-v2 package;
                                               # docker-compose here IS Compose v2 (2.26+)
sudo usermod -aG docker $USER                  # takes effect on next login
cd deploy
WYZE_EMAIL=... WYZE_PASSWORD=... WYZE_API_ID=... WYZE_API_KEY=... \
  docker-compose -f wyze-bridge.compose.yml up -d
```

Debian ships Compose as a standalone binary, not a CLI plugin, so it's
`docker-compose` (hyphen) — `docker compose` (space) is not available there.

Set `WYZE_BRIDGE_URL` (**port 5080**), `PARKING_CAMERA`, a vision key
(`ANTHROPIC_API_KEY` or `AI_GATEWAY_API_KEY`), and optionally `PARKING_PROMPT`
describing which spots matter (e.g. "the two curb spots in front of the house").

Camera names come from the bridge and use **underscores** (`street_cam`, not
`street-cam`); list them at `http://<pi>:5080` or in `docker logs wyze-bridge`.
The worker reads `GET <base>/api/snapshot/<cam>` — no `.jpg` suffix. (The old
mrlt8 image used `/snapshot/<cam>.jpg` on :5000 with an `?api=` key; the fork
uses `BRIDGE_AUTH` instead, and we run LAN-only with it off, so
`WYZE_BRIDGE_API_KEY` is no longer used.)

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
