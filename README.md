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

## Local development

```bash
bun install        # only dev deps (types + tsc); zero runtime deps
bun run typecheck
bun src/index.ts
```
