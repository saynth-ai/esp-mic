# Deploying to live.patoari.com

> **Current deployment (Sep 2026):** live.patoari.com runs on the office build PC, not a
> separate server: Cloudflare proxy (SSL **Full (strict)** via a Configuration Rule for this
> hostname only) → MikroTik port-forward → host nginx with a Let's Encrypt certificate
> (`nginx/live.patoari.com.cloudflare.conf`, origin locked to Cloudflare IPs) → the container
> from `server/docker-compose.yml` on `10.11.21.2:8095`. The steps below describe the
> equivalent setup on a standalone AlmaLinux host.

```
ESP32 ──wss──┐
             ├──▶ Cloudflare (HTTPS) ──http:80──▶ nginx on 115.127.135.48 ──▶ 127.0.0.1:8095 → container
Browser ─https┘
```

Cloudflare terminates TLS, so the origin needs no certificate. nginx on the
AlmaLinux host proxies `live.patoari.com` to the container, which listens only
on `127.0.0.1:8095`.

## What to copy to the server

From `esp32-mic/deploy/` on the build machine:

| File | Purpose |
|---|---|
| `esp32-mic-server-1.1.0.tar.gz` (+ `.sha256`) | the Docker image (`docker save`) |
| `docker-compose.prod.yml` | production stack |
| `.env.production` | secrets: admin password, session secret, device token (**keep private**) |
| `nginx/live.patoari.com.conf` | nginx site |

```bash
# from the build machine (adjust user/port if SSH is not on 22)
scp esp32-mic-server-1.1.0.tar.gz* docker-compose.prod.yml .env.production \
    nginx/live.patoari.com.conf  root@115.127.135.48:/opt/esp32-mic/
```

## On the server (AlmaLinux)

```bash
# 1. Docker (skip if installed)
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker

# 2. Load the image and start the app
cd /opt/esp32-mic
sha256sum -c esp32-mic-server-1.1.0.tar.gz.sha256
docker load -i esp32-mic-server-1.1.0.tar.gz
mkdir -p recordings && sudo chown 1000:1000 recordings
chmod 600 .env.production
docker compose -f docker-compose.prod.yml up -d
curl -s http://127.0.0.1:8095/api/health        # {"status":"ok",...,"version":"1.1.0"}

# 3. nginx site
sudo cp live.patoari.com.conf /etc/nginx/conf.d/
sudo setsebool -P httpd_can_network_connect 1    # SELinux: let nginx proxy to 127.0.0.1:8095
sudo nginx -t && sudo systemctl reload nginx

# 4. Firewall: port 80 must be reachable (by Cloudflare)
sudo firewall-cmd --permanent --add-service=http && sudo firewall-cmd --reload
```

## Cloudflare

- DNS `live.patoari.com` → `115.127.135.48`, **proxied** (orange cloud). Already the case.
- SSL/TLS mode **Flexible** (Cloudflare → origin over HTTP :80) works with this setup.
  For **Full**, add a `listen 443 ssl` server block with a Cloudflare Origin Certificate.
- Network → **WebSockets: On** (default).

## Check

1. https://live.patoari.com → login page. Sign in with `ADMIN_USER` / `ADMIN_PASSWORD` from `.env.production`.
2. `docker logs -f esp32-mic-server` shows `Dashboard login from <your IP>`.

## Point the ESP32 at production

In `esp32/include/secrets.h`:

```c
#define SERVER_HOST    "live.patoari.com"
#define SERVER_PORT    443
#define SERVER_USE_TLS 1           // wss:// — trusts the public roots in ca_roots.h
#define DEVICE_TOKEN   "<DEVICE_TOKEN from .env.production>"
```

Flash, and the device appears on the dashboard within a few seconds.

## Updating

Build a new image on the build machine (`docker build -t esp32-mic-server:X.Y.Z server/`,
`docker save … | gzip`), copy it over, change the tag in `docker-compose.prod.yml`, then
`docker load -i … && docker compose -f docker-compose.prod.yml up -d`. Recordings in
`/opt/esp32-mic/recordings` are untouched. Open recordings are finalized on shutdown.

## Security notes

- The container is bound to `127.0.0.1` only; the public entry is Cloudflare → nginx.
- Dashboard, API, recordings and browser WebSockets require the admin login.
  Devices authenticate separately with `DEVICE_TOKEN`. `/api/health` is public (counts only).
- 10 failed logins from one IP block logins from it for 15 minutes.
- Optional hardening: allow port 80 only from [Cloudflare's IP ranges](https://www.cloudflare.com/ips/)
  so nobody can bypass Cloudflare by hitting the origin IP directly.
