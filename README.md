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

- `GET /health` → `{ "ok": true }`
- `POST /jobs` (auth: `Authorization: Bearer $WORKER_SECRET`)
  ```json
  { "type": "reminder", "message": "go to the grocery store", "delaySeconds": 3300 }
  ```
  → `{ "id": "...", "fireAt": "2026-06-24T18:55:00.000Z" }`

Pending jobs persist to `data/jobs.json`, so they survive a restart. Add new job
types in the `Job` union and the `fire` switch in `src/jobs.ts`.

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
- **Taste** lives in `data/lighting.json` (auto-created): `avoidHueRanges` (red by
  default), `perLight` brightness multipliers / exclusions, drift speed, and the
  scene schedule. Edit it directly or via the API.

It's optional — the worker runs reminders without it. Enable by installing the LAN
library:

```bash
bun add lifx-lan-client
```

Endpoints (all bearer-authed): `GET /lighting` ·
`POST /lighting/theme {palette,brightness,drift,white?}` · `POST /lighting/auto` ·
`POST /lighting/scene {scene}` · `POST /lighting/power {on}` · `POST /lighting/flash` ·
`POST /lighting/enable {enabled}` · `POST /lighting/tune {light?,brightnessScale?,exclude?,avoidRed?}`.

> `src/lighting/lifx.ts` wraps the LAN library — verify its calls against your
> installed `lifx-lan-client` version, and add per-light tuning once you see your
> bulbs' labels in `GET /lighting`.

**Discovery troubleshooting.** `LIFX Client stopped sending due to unbound socket`
(often with high CPU) means UDP broadcast discovery is leaving the wrong interface —
usually **Tailscale**. Set `LIFX_ADDRESS` to the Pi's LAN IP and `LIFX_BROADCAST` to
your subnet broadcast (e.g. `192.168.1.255`). If it persists, set `LIFX_LIGHTS` to
your bulbs' IPs to skip broadcast discovery, or run the worker under `node` instead
of `bun`.

## Local development

```bash
bun install        # only dev deps (types + tsc); zero runtime deps
bun run typecheck
bun src/index.ts
```
