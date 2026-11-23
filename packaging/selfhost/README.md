# Self-hosted T3 Code hub

Templates for running a persistent T3 Code hub server and exposing it over a tailnet (Tailscale or Headscale).

## Files

- `docker-compose.yml` — Runs `t3 serve` in a Node 24 container with persistent state (`T3CODE_HOME=/data/t3`) and a mounted workspace directory, bound to `127.0.0.1:3773` on the host.
- `t3code-hub.service` — `systemd` unit for running an installed `t3` binary as a dedicated `t3code` service user with state under `/var/lib/t3code` and optional overrides in `/etc/t3code/hub.env`.
- `tailscale-serve.sh` — Helper script that logs into a Tailscale or Headscale control plane (when `HEADSCALE_URL` / `TS_AUTHKEY` are set) and publishes the local hub over HTTPS via `tailscale serve`.

## Docker Compose

```bash
cd packaging/selfhost
mkdir -p workspaces
docker compose up -d
docker compose logs -f t3code-hub
```

Override defaults with environment variables or a `.env` file alongside `docker-compose.yml`:

| Variable            | Default        | Description                                   |
| ------------------- | -------------- | --------------------------------------------- |
| `T3CODE_VERSION`    | `latest`       | `t3` npm package version or tag               |
| `T3CODE_PORT`       | `3773`         | Host loopback port forwarded to the container |
| `T3CODE_WORKSPACES` | `./workspaces` | Host path mounted at `/workspace`             |
| `T3CODE_LOG_LEVEL`  | `info`         | Server log level                              |

## systemd

1. Install Node 24+ and the `t3` CLI globally (`npm install -g t3@latest`), and create the service user and workspace root:

   ```bash
   sudo useradd --system --create-home --home-dir /var/lib/t3code --shell /usr/sbin/nologin t3code
   sudo mkdir -p /srv/t3code/workspaces /etc/t3code
   sudo chown -R t3code:t3code /srv/t3code /var/lib/t3code
   ```

2. Install and start the unit:

   ```bash
   sudo cp packaging/selfhost/t3code-hub.service /etc/systemd/system/t3code-hub.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now t3code-hub.service
   ```

3. Inspect logs (including the initial pairing URL) or mint a fresh pairing link:

   ```bash
   sudo journalctl -u t3code-hub.service -f
   sudo -u t3code T3CODE_HOME=/var/lib/t3code t3 pair
   ```

## Tailscale and Headscale HTTPS publication

Keep `T3CODE_HOST=127.0.0.1` so the hub only listens on loopback, then publish it to your tailnet over HTTPS:

```bash
# Standard Tailscale
./packaging/selfhost/tailscale-serve.sh up

# Self-hosted Headscale control server
HEADSCALE_URL=https://headscale.example.com TS_AUTHKEY=tskey-... ./packaging/selfhost/tailscale-serve.sh up

# Check status or stop serving
./packaging/selfhost/tailscale-serve.sh status
./packaging/selfhost/tailscale-serve.sh down
```

Alternatively, pass `--tailscale-serve` (or `T3CODE_TAILSCALE_SERVE=true`) directly to `t3 serve` when the service user has permission to configure `tailscale serve`.
