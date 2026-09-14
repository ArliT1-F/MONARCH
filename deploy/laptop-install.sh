#!/usr/bin/env bash
#
# Monarch — run the Discord bot worker 24/7 on this machine.
#
# Writes systemd *user* services, so there is no sudo, no Docker daemon and no
# hosting bill, and the worker still:
#   • starts itself on boot (once lingering is enabled) and after a crash,
#   • survives you closing the terminal / logging out,
#   • logs to the journal instead of a scrollback buffer,
#   • refuses to let the laptop idle-suspend while it runs.
#
# Two units, because music is two processes now:
#   monarch-bot.service       the worker: Discord gateway, REST, prefix commands
#   monarch-lavalink.service  the music node: Discord voice socket, audio
#                             fetching (YouTube etc.), decoding and Opus
# The bot tells the node what to play over a websocket on localhost:2333; the
# node is what needs outbound UDP, and the node is what needs Java 17+.
#
# Both are outbound-only — nothing has to reach *them*, so there is no port
# forwarding, no DDNS, no TLS certificate, and your home IP stays private.
# (Verified: apps/bot/src/index.ts starts no HTTP listener.)
#
# Already run the music node somewhere else (a VPS, a docker compose stack, a
# hosted Lavalink)? Set LAVALINK_NODES in .env and this script installs only
# the bot — or pass --no-lavalink to say the same thing without editing .env.
#
#   ./deploy/laptop-install.sh --check       preflight only, touches nothing
#   ./deploy/laptop-install.sh               install, enable and start
#   ./deploy/laptop-install.sh --dry-run     print the actions, change nothing
#   ./deploy/laptop-install.sh --headless    also refuse lid-close suspend
#   ./deploy/laptop-install.sh --no-lavalink bot only (music node lives elsewhere)
#   ./deploy/laptop-install.sh --uninstall   stop and remove both units
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_NAME="monarch-bot.service"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/$UNIT_NAME"
ENV_FILE="$REPO/.env"
MODE="install"
HEADLESS=0
WANT_NODE=1 # cleared by --no-lavalink or by LAVALINK_NODES in the env file

# ── the music node ────────────────────────────────────────────────────────
# Pinned on purpose: a Lavalink upgrade changes what the bot's protocol code
# (apps/bot/src/music/lavalink.ts) talks to, so it should be a decision, not a
# side effect of re-running this script. The YouTube plugin version lives in
# docker/lavalink/application.yml, which is copied here verbatim.
LL_UNIT_NAME="monarch-lavalink.service"
LL_UNIT_PATH="$UNIT_DIR/$LL_UNIT_NAME"
LL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/monarch-lavalink"
LAVALINK_VERSION="4.2.2"
LAVALINK_JAR_URL="https://github.com/lavalink-devs/Lavalink/releases/download/${LAVALINK_VERSION}/Lavalink.jar"
LL_CONFIG_SRC="$REPO/docker/lavalink/application.yml"
LL_HEAP="1G"

# ── small helpers ────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  OK=$'\033[32m✓\033[0m'; WARN=$'\033[33m!\033[0m'; BAD=$'\033[31m✗\033[0m'; DIM=$'\033[2m'
  BOLD=$'\033[1m'; OFF=$'\033[0m'
else
  OK="ok"; WARN="warn"; BAD="FAIL"; DIM=""; BOLD=""; OFF=""
fi
PROBLEMS=0
say()  { printf '  %s %s\n' "$1" "$2"; }
good() { say "$OK" "$1"; }
warn() { say "$WARN" "$1"; }
bad()  { say "$BAD" "$1"; PROBLEMS=$((PROBLEMS + 1)); }
note() { printf '      %s%s%s\n' "$DIM" "$1" "$OFF"; }
step() { printf '\n%s%s%s\n' "$BOLD" "$1" "$OFF"; }
die()  { printf '\n%s\n' "$1" >&2; exit 1; }

DRY=0
do_run() {
  if [[ "$DRY" == "1" ]]; then
    printf '  %s[dry-run]%s %s\n' "$DIM" "$OFF" "$*"
  else
    "$@"
  fi
}

usage() { awk 'NR>1 && /^#/{sub(/^#[[:space:]]?/,""); print; next} NR>1{exit}' "${BASH_SOURCE[0]}"; }

# Read one key out of the env file (last assignment wins, like dotenv).
env_value() { [[ -f "$ENV_FILE" ]] || return 0; grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE="check" ;;
    --dry-run) DRY=1 ;;
    --headless) HEADLESS=1 ;;
    --no-lavalink) WANT_NODE=0 ;;
    --uninstall) MODE="uninstall" ;;
    --env-file) [[ $# -ge 2 ]] || die "--env-file needs a path"; ENV_FILE="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1  (try --help)" ;;
  esac
  shift
done

# ── uninstall ────────────────────────────────────────────────────────────
if [[ "$MODE" == "uninstall" ]]; then
  step "Uninstalling $UNIT_NAME and $LL_UNIT_NAME"
  if command -v systemctl >/dev/null 2>&1; then
    for unit in "$UNIT_NAME" "$LL_UNIT_NAME"; do
      [[ -f "$UNIT_DIR/$unit" ]] && systemctl --user disable --now "$unit" 2>/dev/null || true
    done
    do_run systemctl --user daemon-reload
  fi
  do_run rm -f "$UNIT_PATH" "$LL_UNIT_PATH"
  note "the music node's files stay in $LL_DIR (jar, config, plugins) — rm -rf it if you want them gone"
  note "lingering stays on (harmless). Turn it off with: sudo loginctl disable-linger $USER"
  exit 0
fi

# ── preflight ────────────────────────────────────────────────────────────
step "Preflight"

# systemd is the whole point of this script; node is the whole point of the bot.
if command -v systemctl >/dev/null 2>&1; then
  if systemctl --user show-environment >/dev/null 2>&1; then
    good "systemd --user is reachable"
  else
    warn "systemd --user did not answer (no D-Bus session? this runs fine over SSH with XDG_RUNTIME_DIR set, or use the Docker path instead)"
  fi
else
  bad "no systemctl on this box — systemd is how the units keep the bot alive"
  note "on a non-systemd host: docker compose up -d bot lavalink, or run node under tmux + a restart loop"
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  bad "node not found — the unit needs an absolute path to it (nvm users: run this from a shell where node is on PATH)"
else
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "$NODE_MAJOR" -ge 20 ]]; then
    good "node $NODE_MAJOR → $NODE_BIN"
  else
    bad "node $NODE_MAJOR is too old (root package.json engines: >=20)"
  fi
fi

# The bot itself has no native audio dependencies any more: everything that
# used to need ffmpeg, an Opus encoder, a JS runtime and yt-dlp now happens
# inside the music node below. tsx is the only thing worth resolving here, and
# it is how the repo runs TypeScript directly (docker/bot.Dockerfile CMD does
# the same), so a 24/7 unit needs no build step.
if [[ -d "$REPO/apps/bot/node_modules" || -d "$REPO/node_modules" ]]; then
  if node -e "require.resolve('tsx')" >/dev/null 2>&1; then
    good "  tsx"
  else
    bad "  tsx is missing — the unit cannot start the bot. Run: npm ci"
  fi
else
  bad "no node_modules in $REPO — run: npm ci"
fi

# The env file is the only thing the unit reads; a typo here is the usual cause
# of "it started then went quiet".
if [[ -f "$ENV_FILE" ]]; then
  good "env file $ENV_FILE"
  env_has() { grep -Eq "^[[:space:]]*$1=..*" "$ENV_FILE"; }
  for k in DISCORD_BOT_TOKEN DISCORD_CLIENT_ID; do
    if env_has "$k"; then good "  $k set"; else bad "  $k missing/empty in $ENV_FILE — the bot exits at boot without it"; fi
  done
  if env_has APP_URL; then
    APP_URL_N="$(grep -Ec '^[[:space:]]*APP_URL=' "$ENV_FILE")"
    # systemd and dotenv both let the later assignment win, but "later" is not
    # something you want to reason about at 2am — so shout if it happens.
    [[ "$APP_URL_N" -gt 1 ]] && warn "  APP_URL is defined $APP_URL_N times in $ENV_FILE — keep exactly one"
    APP_URL_VAL="$(env_value APP_URL)"
    case "$APP_URL_VAL" in
      *localhost*|*127.0.0.1*|*0.0.0.0*|*.onrender.com*|*onrender*)
        warn "  APP_URL=$APP_URL_VAL — the worker is on this laptop now, but the *dashboard* is not. Backups, exports, embeds, !prefix set and confessions all POST to APP_URL, so point it at the deployed dashboard"
        ;;
      "") warn "  APP_URL is set but empty — the bot falls back to http://localhost:3000";;
      *) good "  APP_URL=$APP_URL_VAL" ;;
    esac
  else
    warn "  APP_URL unset → the bot uses http://localhost:3000 and the dashboard-backed commands (/monarch backup, export, embed, test, !prefix set, confessions) will fail from a laptop worker"
  fi
  env_has INTERNAL_API_TOKEN && good "  INTERNAL_API_TOKEN set" \
    || warn "  INTERNAL_API_TOKEN unset — same effect: no dashboard-backed commands, and prefix changes are ignored"
  env_has MONARCH_OWNER_USER_ID || warn "  MONARCH_OWNER_USER_ID unset — the /burg uno-reverse is off (the worker logs this warning at boot too)"
  env_has SPOTIFY_CLIENT_ID && good "  Spotify credentials set" \
    || note "no SPOTIFY_CLIENT_ID/SECRET → /music play accepts YouTube and search only"

  # Music backend. LAVALINK_NODES pointing somewhere else means this machine
  # only runs the bot, so skip every node-related check and install below.
  if env_has LAVALINK_NODES; then
    LL_NODES_VAL="$(env_value LAVALINK_NODES)"
    WANT_NODE=0
    good "  LAVALINK_NODES=$LL_NODES_VAL → music node is external, nothing to install here"
    note "the worker must be able to reach it; --no-lavalink says the same thing without editing .env"
  else
    note "  LAVALINK_NODES unset → the bot uses ws://localhost:2333, i.e. the node installed below"
  fi
  if env_has LAVALINK_PASSWORD; then
    good "  LAVALINK_PASSWORD set"
  else
    warn "  LAVALINK_PASSWORD unset — bot and node both fall back to Lavalink's published default (youshallnotpass)"
    note "fine while the node is only reachable from this machine or your LAN; set a real one before exposing it"
  fi

  # gitignored, but on a laptop you also carry into cafés: a world-readable
  # file is one `ls` away from a stolen bot token.
  if [[ -n "$(find "$ENV_FILE" -perm /077 2>/dev/null)" ]]; then
    warn "  $ENV_FILE is group/world-readable and holds DISCORD_BOT_TOKEN — chmod 600 $ENV_FILE"
  fi
else
  bad "no env file at $ENV_FILE (cp .env.example .env, or pass --env-file)"
fi

# ── music node preflight ─────────────────────────────────────────────────
if [[ "$WANT_NODE" == "1" ]]; then
  step "Music node (Lavalink $LAVALINK_VERSION)"

  JAVA_BIN="$(command -v java || true)"
  [[ -z "$JAVA_BIN" && -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]] && JAVA_BIN="$JAVA_HOME/bin/java"
  if [[ -z "$JAVA_BIN" ]]; then
    bad "no java — Lavalink is a JVM app and needs Java 17 or newer (21 recommended)"
    # Say the command that works on *this* box rather than a list of five.
    if command -v apt-get >/dev/null 2>&1; then
      note "sudo apt install openjdk-21-jre-headless"
    elif command -v dnf >/dev/null 2>&1; then
      note "sudo dnf install java-21-openjdk-headless"
    elif command -v pacman >/dev/null 2>&1; then
      note "sudo pacman -S jre21-openjdk-headless"
    elif command -v zypper >/dev/null 2>&1; then
      note "sudo zypper install java-21-openjdk-headless"
    elif command -v apk >/dev/null 2>&1; then
      note "sudo apk add openjdk21-jre-headless"
    elif command -v brew >/dev/null 2>&1; then
      note "brew install --cask temurin@21"
    else
      note "get a JDK/JRE 17+ from https://adoptium.net and put java on PATH"
    fi
    note "or point LAVALINK_NODES at a node running elsewhere and re-run with --no-lavalink"
  else
    JAVA_LINE="$("$JAVA_BIN" -version 2>&1 | head -n1)"
    JAVA_MAJOR="$(printf '%s' "$JAVA_LINE" | awk -F'"' '{print $2}' | awk -F. '{ if ($1 == 1) print $2; else print $1 }')"
    if [[ "$JAVA_MAJOR" =~ ^[0-9]+$ ]] && [[ "$JAVA_MAJOR" -ge 17 ]]; then
      good "java $JAVA_MAJOR → $JAVA_BIN"
    else
      bad "java ${JAVA_MAJOR:-unknown} at $JAVA_BIN is too old — Lavalink 4 needs 17+ (21 recommended)"
    fi
  fi

  if [[ -f "$LL_CONFIG_SRC" ]]; then
    good "node config $LL_CONFIG_SRC"
  else
    bad "no node config at $LL_CONFIG_SRC — the repo checkout looks incomplete"
  fi

  if [[ -f "$LL_DIR/Lavalink.jar" && "$(cat "$LL_DIR/.lavalink-version" 2>/dev/null)" == "$LAVALINK_VERSION" ]]; then
    good "Lavalink.jar $LAVALINK_VERSION already in $LL_DIR"
  else
    if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then
      note "will download $LAVALINK_JAR_URL (~60 MB) into $LL_DIR"
    else
      bad "neither curl nor wget — cannot fetch Lavalink.jar"
      note "download it yourself from $LAVALINK_JAR_URL and put it at $LL_DIR/Lavalink.jar"
    fi
  fi
fi

# Two workers on one token is a real hazard, not a nicety: both receive every
# MessageCreate, so !burg and prefix commands fire twice, and two MusicManagers
# fight over one guild's voice channel.
step "Conflicts"
if systemctl --user is-active --quiet "$UNIT_NAME" 2>/dev/null && [[ "$MODE" == "install" ]]; then
  note "an existing $UNIT_NAME is running — it will be restarted with the new unit"
fi
if [[ "$WANT_NODE" == "0" ]] && systemctl --user is-active --quiet "$LL_UNIT_NAME" 2>/dev/null; then
  note "$LL_UNIT_NAME is running but will not be managed any more — stop it if the node moved: systemctl --user disable --now $LL_UNIT_NAME"
fi
warn "still deployed on Render (or anywhere else)? Pause that service. render.yaml's worker and this one must not share DISCORD_BOT_TOKEN"

if command -v loginctl >/dev/null 2>&1 && [[ ! -d "/var/lib/systemd/linger/$USER" ]]; then
  warn "lingering is off — the units start at login, not at boot"
  note "fix (one time, needs sudo): sudo loginctl enable-linger $USER"
elif [[ -d "/var/lib/systemd/linger/$USER" ]]; then
  good "lingering on — both units start at boot, no login required"
fi

if [[ "$MODE" == "check" ]]; then
  printf '\n'
  if [[ "$PROBLEMS" -gt 0 ]]; then
    echo "$PROBLEMS problem(s) to fix before installing. Nothing was changed."
    exit 1
  fi
  echo "Preflight clean. Ready: ./deploy/laptop-install.sh"
  exit 0
fi

[[ "$PROBLEMS" -gt 0 && "$DRY" == "0" ]] && die "$PROBLEMS blocking problem(s) above — fix them, or re-run with --check to see just that list."

NODE_DIR="$(dirname "$NODE_BIN")"
UNIT_PATH_ENV="$NODE_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# ── the music node unit ──────────────────────────────────────────────────
if [[ "$WANT_NODE" == "1" ]]; then
  step "Writing $LL_UNIT_PATH"

  LL_UNIT="$(cat <<LLUNIT
# Generated by deploy/laptop-install.sh — edit the script, not this file.
#
# Lavalink $LAVALINK_VERSION: holds the Discord voice socket, fetches audio
# (YouTube via the youtube-source plugin declared in application.yml) and
# encodes Opus. The bot drives it over ws://localhost:2333 + REST.
[Unit]
Description=Monarch — Lavalink music node (voice + audio)
Documentation=file:$REPO/docs/hosting-laptop.md
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
# WorkingDirectory matters: application.yml resolves ./plugins and ./logs
# relative to it, and both need to be writable (the YouTube plugin is
# downloaded into ./plugins on first boot).
WorkingDirectory=$LL_DIR
# Same env file as the bot, so LAVALINK_PASSWORD and LAVALINK_PORT are read
# from one place. The leading \`-\` means a missing file is not a start failure.
EnvironmentFile=-$ENV_FILE
Environment=PATH=$UNIT_PATH_ENV
# If java is not on PATH yet, install it and re-run this script: the fallback
# below keeps the unit parseable but systemd will fail to start it.
ExecStart=${JAVA_BIN:-/usr/bin/env java} -Xmx$LL_HEAP -jar $LL_DIR/Lavalink.jar
KillSignal=SIGTERM
TimeoutStopSec=20
Restart=always
RestartSec=10
# -Xmx$LL_HEAP plus JVM overhead: enough headroom that the kernel is not the
# one deciding when the node dies.
MemoryHigh=1400M
MemoryMax=1800M
StandardOutput=journal
StandardError=journal
SyslogIdentifier=monarch-lavalink

[Install]
WantedBy=default.target
LLUNIT
)"

  do_run mkdir -p "$LL_DIR" "$UNIT_DIR"
  if [[ "$DRY" == "1" ]]; then
    printf '\n%s%s%s\n' "$DIM" "$LL_UNIT" "$OFF"
  else
    printf '%s\n' "$LL_UNIT" > "$LL_UNIT_PATH"
    good "unit written"
    # Config is repo-tracked, so always refresh it: a fix to client order or
    # trackStuckThresholdMs should reach a running install with one re-run.
    cp "$LL_CONFIG_SRC" "$LL_DIR/application.yml"
    good "application.yml → $LL_DIR/application.yml"
  fi

  if [[ ! -f "$LL_DIR/Lavalink.jar" || "$(cat "$LL_DIR/.lavalink-version" 2>/dev/null)" != "$LAVALINK_VERSION" ]]; then
    step "Fetching Lavalink $LAVALINK_VERSION"
    if [[ "$DRY" == "1" ]]; then
      printf '  %s[dry-run]%s curl -fL -o %s/Lavalink.jar %s\n' "$DIM" "$OFF" "$LL_DIR" "$LAVALINK_JAR_URL"
    elif command -v curl >/dev/null 2>&1; then
      # .tmp then move: a half-downloaded jar is worse than no jar, because
      # systemd would happily restart it forever.
      if curl -fL --retry 3 --connect-timeout 15 -o "$LL_DIR/Lavalink.jar.tmp" "$LAVALINK_JAR_URL"; then
        mv "$LL_DIR/Lavalink.jar.tmp" "$LL_DIR/Lavalink.jar"
        printf '%s\n' "$LAVALINK_VERSION" > "$LL_DIR/.lavalink-version"
        good "Lavalink.jar $LAVALINK_VERSION downloaded"
      else
        rm -f "$LL_DIR/Lavalink.jar.tmp"
        bad "download failed — get it manually: $LAVALINK_JAR_URL → $LL_DIR/Lavalink.jar"
      fi
    elif command -v wget >/dev/null 2>&1; then
      if wget -q -O "$LL_DIR/Lavalink.jar.tmp" "$LAVALINK_JAR_URL"; then
        mv "$LL_DIR/Lavalink.jar.tmp" "$LL_DIR/Lavalink.jar"
        printf '%s\n' "$LAVALINK_VERSION" > "$LL_DIR/.lavalink-version"
        good "Lavalink.jar $LAVALINK_VERSION downloaded"
      else
        rm -f "$LL_DIR/Lavalink.jar.tmp"
        bad "download failed — get it manually: $LAVALINK_JAR_URL → $LL_DIR/Lavalink.jar"
      fi
    else
      bad "neither curl nor wget — cannot fetch Lavalink.jar (put it at $LL_DIR/Lavalink.jar yourself)"
    fi
  fi
fi

# ── the bot unit ─────────────────────────────────────────────────────────
step "Writing $UNIT_PATH"

# The service needs a real PATH even though systemd user units get a thin one.
INHIBIT_BIN="$(command -v systemd-inhibit || true)"
# `sleep` alone is the considerate default: the laptop can still be closed and
# suspended on purpose. --headless adds handle-lid-switch, which is what you
# want for a lid-closed server and what you must remember to stop before the
# laptop goes into a bag.
INHIBIT_WHAT="sleep"
[[ "$HEADLESS" == "1" ]] && INHIBIT_WHAT="sleep:handle-lid-switch"
# Probe it, don't assume it: with no reachable bus systemd-inhibit prints
# "Failed to connect to bus" and exits *without ever execing the bot*, which
# would look like a broken node install. Falling back to a bare ExecStart keeps
# the worker up — only the suspend protection is lost, and the warning says so.
# One inhibitor is enough for the machine: the node is covered by it too.
if [[ -n "$INHIBIT_BIN" ]] && "$INHIBIT_BIN" --what=sleep --who=monarch-bot-probe --why=probe --mode=block true 2>/dev/null; then
  # systemd splits ExecStart on whitespace *before* shell quoting rules apply,
  # so the quotes around --why are part of the unit file, and the binary has to
  # be an absolute path (systemd refuses a bare name).
  EXEC="$INHIBIT_BIN --what=$INHIBIT_WHAT --who=monarch-bot --why=\"Monarch Discord voice worker\" --mode=block $NODE_BIN"
  good "systemd-inhibit works — the laptop will not idle-suspend while the bot runs"
  if [[ "$HEADLESS" == "1" ]]; then
    warn "lid-close is refused too: stop the worker before you put the laptop in a bag"
  else
    note "lid close still suspends normally (both units just reconnect on wake) — add --headless to refuse it"
  fi
else
  EXEC="$NODE_BIN"
  [[ -n "$INHIBIT_BIN" ]] && warn "systemd-inhibit cannot reach logind here — running without it"
  warn "suspend is NOT blocked by the unit; the bot dies the moment the laptop sleeps. Do it in systemd instead:"
  note "sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target"
fi

# Start after the node when this machine runs it, so /music has somewhere to go
# from the first second. The bot reconnects with backoff either way — this is
# ordering, not a hard dependency (hence no Requires=).
NODE_ORDERING=""
if [[ "$WANT_NODE" == "1" ]]; then
  NODE_ORDERING="After=$LL_UNIT_NAME
Wants=$LL_UNIT_NAME
"
fi

UNIT="$(cat <<UNIT
# Generated by deploy/laptop-install.sh — edit the script, not this file.
#
# A user unit on purpose: no sudo, and \`systemctl --user\` / \`journalctl --user\`
# manage it. Starts at boot once lingering is enabled (sudo loginctl
# enable-linger $USER).
[Unit]
Description=Monarch — Discord bot worker (gateway, commands)
Documentation=file:$REPO/docs/hosting-laptop.md
# network-online.target is the honest one here: \`network.target\` only means
# sockets exist, which is true before DHCP has even finished. If the worker
# boots anyway, the login fails, start() exits 1, and Restart=always (below)
# tries again 10 s later — a slow router then costs 10 seconds instead of
# needing you.
After=network-online.target
Wants=network-online.target
${NODE_ORDERING}# A 24/7 home worker should heal itself through an ISP outage, so systemd's
# global restart rate limit is disabled. Prefer fail-fast on a bad token? Delete
# the StartLimitIntervalSec line below and systemd will stay \`failed\` after a
# few rapid restarts instead of trying forever.
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=$REPO
# Load the repo's env the same way \`npm run dev:bot\` does. The leading \`-\`
# means "optional" so a missing file is not a start failure.
EnvironmentFile=-$ENV_FILE
Environment=NODE_ENV=production
Environment=PATH=$UNIT_PATH_ENV
ExecStart=$EXEC --import tsx apps/bot/src/index.ts
# The Dockerfile execs node directly for the same reason: the bot's SIGTERM
# handler closes the gateway session so Discord doesn't hold a zombie session,
# and it only works if the signal reaches node (an \`npm run\` wrapper absorbs
# it and exits 143). systemd's default SIGTERM is exactly right — do not wrap
# ExecStart in npm.
KillSignal=SIGTERM
TimeoutStopSec=20
Restart=always
RestartSec=10
# One node process, no audio pipeline of its own any more (that is the node's
# job), on an always-on laptop that is also your desktop: stay bounded so the
# worker can't eat the machine.
MemoryHigh=640M
MemoryMax=1G
StandardOutput=journal
StandardError=journal
SyslogIdentifier=monarch-bot

[Install]
WantedBy=default.target
UNIT
)"

do_run mkdir -p "$UNIT_DIR"
if [[ "$DRY" == "1" ]]; then
  printf '\n%s%s%s\n' "$DIM" "$UNIT" "$OFF"
else
  printf '%s\n' "$UNIT" > "$UNIT_PATH"
  good "unit written"
fi

step "Enabling"
if [[ "$DRY" == "0" ]]; then
  systemctl --user daemon-reload
  if [[ "$WANT_NODE" == "1" ]]; then
    systemctl --user enable --now "$LL_UNIT_NAME"
    good "$LL_UNIT_NAME enabled + started"
    note "first boot downloads the YouTube plugin into $LL_DIR/plugins — give it ~30 s"
  fi
  systemctl --user enable --now "$UNIT_NAME"
  good "$UNIT_NAME enabled + started"
  sleep 3
  printf '\n'
  if [[ "$WANT_NODE" == "1" ]]; then
    systemctl --user --no-pager --full status "$LL_UNIT_NAME" | sed 's/^/  /' || true
    printf '\n'
  fi
  systemctl --user --no-pager --full status "$UNIT_NAME" | sed 's/^/  /' || true
  printf '\n%s\n' "Watch them:"
  if [[ "$WANT_NODE" == "1" ]]; then
    printf '  journalctl --user -u %s -f   # music node\n' "$LL_UNIT_NAME"
  fi
  printf '  journalctl --user -u %s -f   # bot\n' "$UNIT_NAME"
  note "look for: bot ready  { instance: \"$HOSTNAME\", guilds: N, burg: true, prefixCommands: true }"
  note "and:      music: \"1 node(s) …\" — that line is the node handshake from the bot's side"
  if [[ "$WANT_NODE" == "1" ]]; then
    note "then in Discord: /music play <song> — the node holds the UDP voice socket, this box allows it"
  else
    note "then in Discord: /music play <song> — it plays through $(env_value LAVALINK_NODES)"
  fi
else
  if [[ "$WANT_NODE" == "1" ]]; then
    printf '  %s[dry-run]%s systemctl --user daemon-reload && systemctl --user enable --now %s\n' "$DIM" "$OFF" "$LL_UNIT_NAME"
  fi
  printf '  %s[dry-run]%s systemctl --user daemon-reload && systemctl --user enable --now %s\n' "$DIM" "$OFF" "$UNIT_NAME"
fi
