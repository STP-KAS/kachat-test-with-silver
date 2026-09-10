# KaChat Desktop

QUICK START (Mac, Linux, Windows/WSL)

```
git clone https://github.com/KaspaSilver/KaChat-Desktop.git
cd KaChat-Desktop
npm install
npm run dev
```

Then open the address Vite prints (typically `http://localhost:5173/`).

To stop KaChat, return to the terminal and press Control+C.

KaChat stores test accounts and settings in the browser. To remove them,
clear browser site data for localhost.

To run KaChat again later:

```
cd KaChat-Desktop && npm run dev
```



## Run it in Docker

If you would rather not install Node, there is a Dockerfile and a compose file:

```
docker compose up -d --build
```

Then open `http://localhost:5173`, or this machine's address from another
device on the network. To stop it: `docker compose down`.

Serve it somewhere else by setting the port:

```
KACHAT_DESKTOP_PORT=8090 docker compose up -d --build
```

Accounts and settings live in the browser you open it with, not in the
container, so `docker compose down` loses nothing and there is no volume to
back up.

The Swaps tab needs a ChangeNOW key. It is read at run time rather than baked
into the image, so put it in a `.env` next to the compose file:

```
VITE_CHANGENOW_API_KEY=your-key-here
```

**What the container serves.** A production build, not the dev server. It runs
`npm run build` at start and serves the result with `vite preview`. The build
gives every asset a content-hashed filename, which is the only cache-busting
that cannot be forgotten: a returning visitor either gets a file byte-for-byte
identical to the one they cached, or a different URL. The dev server's
unhashed filenames could hand someone one old file and one new one, and the app
would run a mix of two versions.

The build runs at container start rather than image build because Vite inlines
every `VITE_` variable into the bundle when it builds, and `VITE_CHANGENOW_API_KEY`
is passed as a run-time environment variable. It takes well under a second.

The Nextcloud `/nc-proxy` route is a connect middleware in `vite.config.mjs`,
mounted on both `configureServer` and `configurePreviewServer`, so it works the
same on the built site as it does under `npm run dev`. It is what works around
Nextcloud sending no CORS headers on WebDAV.

**Reaching it by domain name.** Vite refuses requests whose `Host` header it
does not recognise. `vite.config.mjs` allows `.duckdns.org` on both the dev and
preview servers; any other domain in front of this needs adding to
`server.allowedHosts` and `preview.allowedHosts`. Plain IP addresses are fine
without any change.

**Serving it yourself, without Docker.** `npm run serve` builds and previews in
one step; `npm run build` alone writes the site to `dist/`. If you serve `dist/`
with your own web server instead, `/nc-proxy` has to be reimplemented there or
the Nextcloud features stop working.


## Self-Hosted Cloud (Nextcloud) Setup

<details>
<summary>Summary</summary>

KaChat can preview and stream **Nextcloud public share links** (photos and videos) directly
inside a chat, and can use Nextcloud as a private destination for chat-history backup. Hosting
your own Nextcloud gives you a personal media/backup server that you fully control — no third
party ever sees your files.

This one-paste installer brings up three things together:

| Service | What it is | Default URL |
|---------|-----------|-------------|
| **Nextcloud** | Your private cloud (files, photos, videos) with photo/video previews enabled | `http://YOUR-IP:8080` |
| **Portainer** | A web UI to see and manage all your Docker containers | `https://YOUR-IP:9443` |
| **Nginx Proxy Manager** | A web UI to create reverse-proxy hosts + free Let's Encrypt SSL | `http://YOUR-IP:81` |

Everything runs in Docker, in a folder called `kachat-cloud` in your home directory. Media
previews are pre-configured: **Imaginary** handles images (including iPhone HEIC), and **ffmpeg**
is baked in so uploaded **videos** generate thumbnails too.

> Use a machine that stays on — a spare PC, a mini-PC, or a home server works great. You need
> ~4 GB RAM free and a few GB of disk.

### Step 1 — Install everything

The one-command install below is the most reliable option — a long copy-paste can get
mangled by the terminal. Each command checks for Docker and installs it if missing (with a
distro-package fallback on Linux), makes sure **Docker Compose v2** is present, starts the
engine, then brings up Nextcloud (with photo/video previews enabled), Portainer, and Nginx
Proxy Manager. Re-running is safe — it reuses the passwords already saved in `.env`.

**macOS & Linux** — open a terminal and run:

```bash
curl -fsSL https://raw.githubusercontent.com/KaspaSilver/KaChat-Desktop/main/scripts/kachat-cloud-setup.sh -o /tmp/kachat-cloud-setup.sh && bash /tmp/kachat-cloud-setup.sh
```

**Windows** — open **PowerShell as Administrator** and run:

```powershell
irm https://raw.githubusercontent.com/KaspaSilver/KaChat-Desktop/main/scripts/kachat-cloud-setup.ps1 | iex
```

<details>
<summary><b>Prefer to review and paste the full script yourself? Expand for the complete macOS/Linux and Windows blocks.</b></summary>

**macOS & Linux:**

```bash
# === KaChat self-hosted cloud: Nextcloud + Portainer + Nginx Proxy Manager ===
# Wrapped in a function so any fatal step can stop cleanly without closing your terminal.
kachat_install() {
  KC_DIR="$HOME/kachat-cloud"; mkdir -p "$KC_DIR"; cd "$KC_DIR" || return 1
  OS="$(uname)"

  # 1) Make sure Docker is installed
  if command -v docker >/dev/null 2>&1; then
    echo "Docker is already installed."
  elif [ "$OS" = "Darwin" ]; then
    echo "Docker not found — installing Docker Desktop (Homebrew)..."
    command -v brew >/dev/null 2>&1 || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    brew install --cask docker || brew install --cask docker-desktop
    open -a Docker
    echo ""
    echo ">> A Docker Desktop window will open. Complete its first-run setup (accept the terms and"
    echo ">> let it start). This script continues automatically once the engine is running. If it"
    echo ">> doesn't continue within a few minutes, just run the same command again."
  else
    echo "Docker not found — installing..."
    # get.docker.com needs curl; install it first if missing
    if ! command -v curl >/dev/null 2>&1; then
      sudo apt-get update && sudo apt-get install -y curl \
        || sudo dnf install -y curl || sudo yum install -y curl \
        || sudo pacman -Sy --noconfirm curl || sudo zypper install -y curl || true
    fi
    # Official installer — run as ROOT so its package step can't stall on a hidden sudo prompt
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sudo sh /tmp/get-docker.sh
    # Fallback to the distro's own package if the convenience script didn't land a working docker
    if ! command -v docker >/dev/null 2>&1; then
      echo "Convenience script didn't install Docker — trying the distro package..."
      sudo apt-get update && sudo apt-get install -y docker.io \
        || sudo dnf install -y docker || sudo yum install -y docker \
        || sudo pacman -Sy --noconfirm docker || sudo zypper install -y docker || true
    fi
    sudo usermod -aG docker "$USER" 2>/dev/null || true
  fi

  # Stop here (cleanly) if Docker still isn't present
  if ! command -v docker >/dev/null 2>&1; then
    echo "!! Docker could not be installed automatically."
    echo "   Install it manually from https://docs.docker.com/engine/install/ then run this block again."
    return 1
  fi

  # 2) Start the engine and wait until it actually responds
  if [ "$OS" != "Darwin" ]; then
    sudo systemctl enable --now docker 2>/dev/null || sudo service docker start 2>/dev/null || true
  fi
  echo "Waiting for the Docker engine to be ready..."
  tries=0
  until docker info >/dev/null 2>&1 || sudo docker info >/dev/null 2>&1; do
    tries=$((tries+1))
    if [ "$tries" -eq 20 ]; then
      if [ "$OS" = "Darwin" ]; then
        echo "Still waiting — make sure the Docker Desktop window has finished starting (whale icon steady)."
      else
        echo "Still waiting — in another terminal check:  sudo systemctl status docker   (WSL:  sudo service docker start)"
      fi
    fi
    if [ "$tries" -ge 100 ]; then
      echo "!! Docker isn't ready yet. Once Docker is running, run the same command again to continue."
      return 1
    fi
    sleep 3
  done
  if docker info >/dev/null 2>&1; then DK="docker"; else DK="sudo docker"; fi
  echo "Docker engine is ready."

  # 2b) Ensure Docker Compose v2 — the distro 'docker.io' package ships without it
  if [ "$OS" != "Darwin" ] && ! $DK compose version >/dev/null 2>&1; then
    echo "Installing Docker Compose v2..."
    sudo apt-get install -y docker-compose-v2 2>/dev/null \
      || sudo apt-get install -y docker-compose-plugin 2>/dev/null \
      || sudo dnf install -y docker-compose-plugin 2>/dev/null \
      || sudo pacman -Sy --noconfirm docker-compose 2>/dev/null || true
    # last resort: drop the official compose plugin binary in place
    if ! $DK compose version >/dev/null 2>&1; then
      sudo mkdir -p /usr/local/lib/docker/cli-plugins
      sudo curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
        -o /usr/local/lib/docker/cli-plugins/docker-compose && sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
    fi
  fi
  if ! $DK compose version >/dev/null 2>&1; then
    echo "!! Docker Compose v2 is unavailable and could not be installed."
    echo "   See https://docs.docker.com/compose/install/ then run this block again."
    return 1
  fi

  # 3) Generate secrets and detect this machine's LAN IP
  gen() { openssl rand -hex 16; }
  LAN_IP=$( (ipconfig getifaddr en0 2>/dev/null) || (hostname -I 2>/dev/null | awk '{print $1}') || echo 127.0.0.1 )
  if [ ! -f .env ]; then cat > .env <<EOF
DB_ROOT_PASSWORD=$(gen)
DB_PASSWORD=$(gen)
NC_ADMIN_USER=admin
NC_ADMIN_PASSWORD=$(gen)
IMAGINARY_SECRET=$(gen)
NC_TRUSTED_DOMAINS=localhost 127.0.0.1 ${LAN_IP}
DUCKDNS_SUBDOMAIN=changeme
DUCKDNS_TOKEN=changeme
EOF
  fi

  # 4) Custom Nextcloud image with ffmpeg (needed for video thumbnails)
  cat > Dockerfile.nextcloud <<'EOF'
FROM nextcloud:stable
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
EOF

  # 5) The stack
  cat > docker-compose.yml <<'EOF'
name: kachat-cloud
services:
  npm:
    image: jc21/nginx-proxy-manager:latest
    restart: unless-stopped
    ports: ["80:80", "443:443", "81:81"]
    volumes:
      - npm_data:/data
      - npm_letsencrypt:/etc/letsencrypt
    networks: [cloud]
  portainer:
    image: portainer/portainer-ce:latest
    restart: unless-stopped
    ports: ["9443:9443"]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - portainer_data:/data
    networks: [cloud]
  nextcloud-db:
    image: mariadb:10.11
    restart: unless-stopped
    command: --transaction-isolation=READ-COMMITTED --log-bin=binlog --binlog-format=ROW
    environment:
      MARIADB_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}
      MARIADB_DATABASE: nextcloud
      MARIADB_USER: nextcloud
      MARIADB_PASSWORD: ${DB_PASSWORD}
    volumes: ["nextcloud_db:/var/lib/mysql"]
    networks: [cloud]
  nextcloud-redis:
    image: redis:7-alpine
    restart: unless-stopped
    networks: [cloud]
  imaginary:
    image: nextcloud/aio-imaginary:latest
    restart: unless-stopped
    cap_add: ["SYS_NICE"]
    environment:
      IMAGINARY_SECRET: ${IMAGINARY_SECRET}
    networks: [cloud]
  nextcloud:
    build:
      context: .
      dockerfile: Dockerfile.nextcloud
    restart: unless-stopped
    ports: ["8080:80"]
    environment:
      MYSQL_HOST: nextcloud-db
      MYSQL_DATABASE: nextcloud
      MYSQL_USER: nextcloud
      MYSQL_PASSWORD: ${DB_PASSWORD}
      REDIS_HOST: nextcloud-redis
      NEXTCLOUD_ADMIN_USER: ${NC_ADMIN_USER}
      NEXTCLOUD_ADMIN_PASSWORD: ${NC_ADMIN_PASSWORD}
      NEXTCLOUD_TRUSTED_DOMAINS: ${NC_TRUSTED_DOMAINS}
      TRUSTED_PROXIES: 172.16.0.0/12
    depends_on: [nextcloud-db, nextcloud-redis, imaginary]
    volumes: ["nextcloud_data:/var/www/html"]
    networks: [cloud]
  duckdns:
    image: linuxserver/duckdns:latest
    restart: unless-stopped
    profiles: [public]
    environment:
      SUBDOMAINS: ${DUCKDNS_SUBDOMAIN}
      TOKEN: ${DUCKDNS_TOKEN}
    networks: [cloud]
volumes:
  npm_data:
  npm_letsencrypt:
  portainer_data:
  nextcloud_db:
  nextcloud_data:
networks:
  cloud:
EOF

  # 6) Build and start
  if ! $DK compose up -d --build; then
    echo ""
    echo "!! Build or start failed — scroll up to read the error, fix it, then run this block again."
    return 1
  fi

  # 7) Wait for first-time setup, then switch on photo/video previews
  echo "Waiting for Nextcloud to finish first-time setup (can take a few minutes)..."
  tries=0
  until $DK compose exec -T -u www-data nextcloud php occ status 2>/dev/null | grep -q "installed: true"; do
    tries=$((tries+1)); [ "$tries" -gt 120 ] && { echo "Timed out waiting for setup; check: $DK compose logs nextcloud"; break; }
    sleep 5
  done
  SECRET=$(grep IMAGINARY_SECRET .env | cut -d= -f2)
  occ() { $DK compose exec -T -u www-data nextcloud php occ "$@"; }
  occ config:system:set enable_previews --value=true --type=boolean
  occ config:system:set preview_max_x --value=2048
  occ config:system:set preview_max_y --value=2048
  occ config:system:set preview_imaginary_url --value=http://imaginary:9000
  occ config:system:set preview_imaginary_key --value="$SECRET"
  occ config:system:delete enabledPreviewProviders 2>/dev/null || true
  occ config:system:set enabledPreviewProviders 0 --value='OC\Preview\Imaginary'
  occ config:system:set enabledPreviewProviders 1 --value='OC\Preview\Movie'
  occ config:system:set enabledPreviewProviders 2 --value='OC\Preview\MP4'
  occ config:system:set enabledPreviewProviders 3 --value='OC\Preview\MOV'
  occ config:system:set enabledPreviewProviders 4 --value='OC\Preview\MKV'
  occ config:system:set enabledPreviewProviders 5 --value='OC\Preview\AVI'
  occ app:install previewgenerator 2>/dev/null || occ app:enable previewgenerator 2>/dev/null || true

  echo ""
  echo "================ KaChat cloud is ready ================"
  echo "Nextcloud            ->  http://${LAN_IP}:8080"
  echo "Nginx Proxy Manager  ->  http://${LAN_IP}:81   (first login: admin@example.com / changeme)"
  echo "Portainer            ->  https://${LAN_IP}:9443 (create your admin user within 5 min)"
  echo ""
  echo "Your Nextcloud admin username/password is saved in:  ${KC_DIR}/.env"
  echo "======================================================"
}
kachat_install
```

**Windows (PowerShell as Administrator):**

```powershell
# === KaChat self-hosted cloud (Windows / PowerShell as Administrator) ===
$KC = "$HOME\kachat-cloud"; New-Item -ItemType Directory -Force -Path $KC | Out-Null; Set-Location $KC

# 1) Install Docker Desktop if missing
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements
  Write-Host "Docker Desktop installed. Launch it from the Start Menu, finish first-run setup, then paste this block again." -ForegroundColor Yellow
  return
}
Write-Host "Waiting for the Docker engine to be ready..."
while (-not (docker info 2>$null)) { Start-Sleep 3 }

# 2) Secrets + LAN IP
function Gen { -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) }) }
$LAN = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } | Select-Object -First 1).IPAddress
if (-not $LAN) { $LAN = "127.0.0.1" }
if (-not (Test-Path .env)) {
@"
DB_ROOT_PASSWORD=$(Gen)
DB_PASSWORD=$(Gen)
NC_ADMIN_USER=admin
NC_ADMIN_PASSWORD=$(Gen)
IMAGINARY_SECRET=$(Gen)
NC_TRUSTED_DOMAINS=localhost 127.0.0.1 $LAN
DUCKDNS_SUBDOMAIN=changeme
DUCKDNS_TOKEN=changeme
"@ | Set-Content -Encoding ASCII .env
}

# 3) Custom Nextcloud image with ffmpeg (needed for video thumbnails)
@'
FROM nextcloud:stable
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
'@ | Set-Content -Encoding ASCII Dockerfile.nextcloud

# 4) The stack
@'
name: kachat-cloud
services:
  npm:
    image: jc21/nginx-proxy-manager:latest
    restart: unless-stopped
    ports: ["80:80", "443:443", "81:81"]
    volumes:
      - npm_data:/data
      - npm_letsencrypt:/etc/letsencrypt
    networks: [cloud]
  portainer:
    image: portainer/portainer-ce:latest
    restart: unless-stopped
    ports: ["9443:9443"]
    volumes:
      - //var/run/docker.sock:/var/run/docker.sock
      - portainer_data:/data
    networks: [cloud]
  nextcloud-db:
    image: mariadb:10.11
    restart: unless-stopped
    command: --transaction-isolation=READ-COMMITTED --log-bin=binlog --binlog-format=ROW
    environment:
      MARIADB_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}
      MARIADB_DATABASE: nextcloud
      MARIADB_USER: nextcloud
      MARIADB_PASSWORD: ${DB_PASSWORD}
    volumes: ["nextcloud_db:/var/lib/mysql"]
    networks: [cloud]
  nextcloud-redis:
    image: redis:7-alpine
    restart: unless-stopped
    networks: [cloud]
  imaginary:
    image: nextcloud/aio-imaginary:latest
    restart: unless-stopped
    cap_add: ["SYS_NICE"]
    environment:
      IMAGINARY_SECRET: ${IMAGINARY_SECRET}
    networks: [cloud]
  nextcloud:
    build:
      context: .
      dockerfile: Dockerfile.nextcloud
    restart: unless-stopped
    ports: ["8080:80"]
    environment:
      MYSQL_HOST: nextcloud-db
      MYSQL_DATABASE: nextcloud
      MYSQL_USER: nextcloud
      MYSQL_PASSWORD: ${DB_PASSWORD}
      REDIS_HOST: nextcloud-redis
      NEXTCLOUD_ADMIN_USER: ${NC_ADMIN_USER}
      NEXTCLOUD_ADMIN_PASSWORD: ${NC_ADMIN_PASSWORD}
      NEXTCLOUD_TRUSTED_DOMAINS: ${NC_TRUSTED_DOMAINS}
      TRUSTED_PROXIES: 172.16.0.0/12
    depends_on: [nextcloud-db, nextcloud-redis, imaginary]
    volumes: ["nextcloud_data:/var/www/html"]
    networks: [cloud]
  duckdns:
    image: linuxserver/duckdns:latest
    restart: unless-stopped
    profiles: [public]
    environment:
      SUBDOMAINS: ${DUCKDNS_SUBDOMAIN}
      TOKEN: ${DUCKDNS_TOKEN}
    networks: [cloud]
volumes:
  npm_data:
  npm_letsencrypt:
  portainer_data:
  nextcloud_db:
  nextcloud_data:
networks:
  cloud:
'@ | Set-Content -Encoding ASCII docker-compose.yml

# 5) Build and start (only continue to preview setup if this succeeds)
docker compose up -d --build
if ($LASTEXITCODE -ne 0) {
  Write-Host "!! Build or start failed — scroll up to read the error, fix it, then paste this block again." -ForegroundColor Yellow
} else {

# 6) Wait for setup, then switch on photo/video previews
Write-Host "Waiting for Nextcloud to finish first-time setup (can take a few minutes)..."
$tries = 0
do { Start-Sleep 5; $tries++; $st = docker compose exec -T -u www-data nextcloud php occ status 2>$null } until ($st -match "installed: true" -or $tries -gt 120)
$SECRET = (Select-String -Path .env -Pattern 'IMAGINARY_SECRET=(.*)').Matches.Groups[1].Value
function occ { docker compose exec -T -u www-data nextcloud php occ @args }
occ config:system:set enable_previews --value=true --type=boolean
occ config:system:set preview_max_x --value=2048
occ config:system:set preview_max_y --value=2048
occ config:system:set preview_imaginary_url --value=http://imaginary:9000
occ config:system:set preview_imaginary_key --value="$SECRET"
occ config:system:delete enabledPreviewProviders 2>$null
occ config:system:set enabledPreviewProviders 0 --value='OC\Preview\Imaginary'
occ config:system:set enabledPreviewProviders 1 --value='OC\Preview\Movie'
occ config:system:set enabledPreviewProviders 2 --value='OC\Preview\MP4'
occ config:system:set enabledPreviewProviders 3 --value='OC\Preview\MOV'
occ config:system:set enabledPreviewProviders 4 --value='OC\Preview\MKV'
occ config:system:set enabledPreviewProviders 5 --value='OC\Preview\AVI'
occ app:install previewgenerator 2>$null

Write-Host ""
Write-Host "================ KaChat cloud is ready ================"
Write-Host "Nextcloud            ->  http://$LAN:8080"
Write-Host "Nginx Proxy Manager  ->  http://$LAN:81   (first login: admin@example.com / changeme)"
Write-Host "Portainer            ->  https://$LAN:9443 (create your admin user within 5 min)"
Write-Host ""
Write-Host "Your Nextcloud admin username/password is saved in:  $KC\.env"
Write-Host "======================================================"
}
```

> **Copy tips:** copy only the command text — no leading `$`, `%`, or `>` prompt
> symbols. The script is safe to run again; it reuses the passwords it already
> generated in `.env`.

</details>

### Step 2 — Log in and grab your passwords

Your generated admin password lives in `kachat-cloud/.env` (the `NC_ADMIN_PASSWORD` line). Open
`http://YOUR-IP:8080`, sign in as `admin` with that password, and you're in.

- **Portainer** (`https://YOUR-IP:9443`) — set an admin user on first visit to manage/monitor all containers.
- **Nginx Proxy Manager** (`http://YOUR-IP:81`) — first login is `admin@example.com` / `changeme`; it forces you to set a real email and password immediately.

### Step 3a — Run it locally (on your own network)

If you only want to use it inside your home, you're already done. From any device on the same
Wi-Fi/router, open `http://YOUR-IP:8080`. Nothing needs to be exposed to the internet, and no
router changes are required.

> To reach it from other devices by the IP shown above, give the host machine a **static/reserved
> IP** in your router's DHCP settings so the address doesn't change.

### Step 3b — Make it reachable anywhere (free DuckDNS domain)

This gives you a public HTTPS address like `https://yourname.duckdns.org` that works from
anywhere, with an automatic Let's Encrypt certificate managed by Nginx Proxy Manager.

1. **Create a free domain.** Go to [duckdns.org](https://www.duckdns.org), sign in, create a
   subdomain (e.g. `yourname`), and copy your **token** from the top of the page.

2. **Enable the DuckDNS updater** so your domain always points at your current home IP. Edit
   `kachat-cloud/.env` and set:
   ```
   DUCKDNS_SUBDOMAIN=yourname
   DUCKDNS_TOKEN=your-duckdns-token
   ```
   Then start it (from the `kachat-cloud` folder):
   ```bash
   docker compose --profile public up -d
   ```

3. **Forward ports on your router.** In your router admin page, forward external ports **80** and
   **443** (TCP) to the **internal IP of the host machine**. These go to Nginx Proxy Manager,
   which handles SSL and routing — you do **not** forward Nextcloud's 8080 directly.

4. **Create the proxy host in Nginx Proxy Manager** (`http://YOUR-IP:81`):
   - **Hosts → Proxy Hosts → Add Proxy Host**
   - **Domain Names:** `yourname.duckdns.org`
   - **Scheme:** `http` · **Forward Hostname:** `nextcloud` · **Forward Port:** `80`
   - Turn on **Block Common Exploits** and **Websockets Support**
   - **SSL tab:** *Request a new SSL Certificate*, enable **Force SSL** and **HTTP/2**, agree to
     the Let's Encrypt terms, and save.

5. **Tell Nextcloud about the domain.** From the `kachat-cloud` folder, run:
   ```bash
   docker compose exec -u www-data nextcloud php occ config:system:set trusted_domains 1 --value=yourname.duckdns.org
   docker compose exec -u www-data nextcloud php occ config:system:set overwrite.cli.url --value=https://yourname.duckdns.org
   docker compose exec -u www-data nextcloud php occ config:system:set overwriteprotocol --value=https
   ```
   *(On Windows use the same commands in PowerShell.)*

You can now open `https://yourname.duckdns.org` from anywhere.

### Verify previews work

Upload a photo (including an iPhone `.HEIC`) and a video to Nextcloud's **Files** app — each
should show a thumbnail within a few seconds. To share into a KaChat chat, open a file → **Share**
→ create a **public link** and paste that link into a chat. In KaChat, tapping the link previews
the image or streams the video in high quality (nothing is fetched until you tap it).

### Everyday commands

Run these from the `kachat-cloud` folder:

```bash
docker compose ps           # see what's running
docker compose logs -f      # watch logs
docker compose down         # stop everything (data is kept in Docker volumes)
docker compose up -d        # start again
docker compose pull && docker compose up -d --build   # update to newest images
```


### Uninstall / revert everything

To completely undo this setup on the machine — remove the KaChat cloud containers, all
their data and images, the `kachat-cloud` folder, **and Docker itself** — run the one-liner
for your system.

**macOS & Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/KaspaSilver/KaChat-Desktop/main/scripts/kachat-cloud-uninstall.sh -o /tmp/kachat-cloud-uninstall.sh && bash /tmp/kachat-cloud-uninstall.sh
```

**Windows** — PowerShell as Administrator:

```powershell
irm https://raw.githubusercontent.com/KaspaSilver/KaChat-Desktop/main/scripts/kachat-cloud-uninstall.ps1 | iex
```

> This permanently deletes the Nextcloud data volumes and uninstalls Docker. To wipe the
> KaChat cloud but **keep** Docker, instead run:
> `cd ~/kachat-cloud && docker compose --profile public down -v --rmi all && cd ~ && rm -rf ~/kachat-cloud`

==================================================
COPYING COMMANDS
==================================================

- Copy only the command text.
- Do not copy Terminal prompt symbols such as %, $, or ~.
- Do not add Markdown backticks.

</details>
