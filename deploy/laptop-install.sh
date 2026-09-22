#!/usr/bin/env bash
#
# Monarch — run the Discord bot worker 24/7 on this machine.
#
# Writes a systemd *user* service, so there is no sudo, no Docker daemon and no
# hosting bill, and the worker still:
#   • starts itself on boot (once lingering is enabled) and after a crash,
#   • survives you closing the terminal / logging out,
#   • logs to the journal instead of a scrollback buffer,
#   • refuses to let the laptop idle-suspend while it runs.
#
# The bot is outbound-only — Discord gateway WSS, Discord REST, and HTTPS to
# your dashboard's /api/internal/*. Nothing has to reach *it*, so there is no
# port forwarding, no DDNS, no TLS certificate, and your home IP stays private.
# (Verified: apps/bot/src/index.ts starts no HTTP listener.) Voice audio is UDP,
# which is the whole reason for doing this: home routers pass outbound UDP
# fine, Render's containers do not.
#
#   ./deploy/laptop-install.sh --check       preflight only, touches nothing
#   ./deploy/laptop-install.sh               install, enable and start
#   ./deploy/laptop-install.sh --dry-run     print the actions, change nothing
#   ./deploy/laptop-install.sh --headless    also refuse lid-close suspend
#   ./deploy/laptop-install.sh --uninstall   stop and remove the unit
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_NAME="monarch-bot.service"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/$UNIT_NAME"
ENV_FILE="$REPO/.env"
MODE="install"
HEADLESS=0

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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE="check" ;;
    --dry-run) DRY=1 ;;
    --headless) HEADLESS=1 ;;
    --uninstall) MODE="uninstall" ;;
    --env-file) [[ $# -ge 2 ]] || die "--env-file needs a path"; ENV_FILE="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1  (try --help)" ;;
  esac
  shift
done

# ── uninstall ────────────────────────────────────────────────────────────
if [[ "$MODE" == "uninstall" ]]; then
  step "Uninstalling $UNIT_NAME"
  if [[ -f "$UNIT_PATH" ]] && command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
  fi
  do_run rm -f "$UNIT_PATH"
  command -v systemctl >/dev/null 2>&1 && do_run systemctl --user daemon-reload
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
  bad "no systemctl on this box — systemd is how the unit keeps the bot alive"
  note "on a non-systemd host: docker compose up -d bot, or run node under tmux + a restart loop"
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

# Everything below resolves from the repo, the same way `npm run dev:bot` does.
if [[ -d "$REPO/apps/bot/node_modules" || -d "$REPO/node_modules" ]]; then
  good "dependencies installed"
  deps_check() { # name, required?, hint
    if node -e "require.resolve('$1')" >/dev/null 2>&1; then
      good "  $1"
    elif [[ "$2" == "req" ]]; then
      bad "  $1 is missing — voice cannot work without it. Run: npm ci  (hint: $3)"
    else
      warn "  $1 not resolvable — $3"
    fi
  }
  # tsx is how the repo runs TypeScript directly (docker/bot.Dockerfile CMD does
  # the same), so a 24/7 unit needs no build step.
  deps_check "tsx" req "npm ci"
  # @discordjs/voice has no built-in codec. The PCM pipeline in
  # apps/bot/src/music/audio.ts decodes with ffmpeg and re-encodes with this,
  # so an Opus encoder is mandatory whenever ffmpeg is present. Without either
  # one YouTube still plays (Opus passthrough) — just without volume.
  deps_check "opusscript" req "npm i opusscript -w @monarch/bot && npm ci"
  # Encryption for the voice socket: DAVE (current) or libsodium (legacy mode).
  deps_check "@snazzah/davey" opt "npm ci; without it @discordjs/voice cannot key-exchange"
  deps_check "libsodium-wrappers" opt "npm ci"
  if command -v ffmpeg >/dev/null 2>&1; then
    good "  ffmpeg on PATH ($(command -v ffmpeg))"
  elif node -e "require.resolve('@ffmpeg-installer/ffmpeg')" >/dev/null 2>&1; then
    good "  ffmpeg via @ffmpeg-installer/ffmpeg (bundled static build)"
    note "or install a system one: sudo apt install ffmpeg"
  else
    warn "  no ffmpeg — /music still plays YouTube (Opus passthrough) but volume is unavailable. sudo apt install ffmpeg"
  fi
  # yt-dlp is what actually fetches the audio (see apps/bot/src/music/ytdlp.ts).
  # The bot downloads the official build into .monarch/bin on first use, so a
  # missing binary is a warning — but installing your own keeps extractor
  # updates on your schedule instead of on the bot's.
  if command -v yt-dlp >/dev/null 2>&1; then
    good "  yt-dlp on PATH ($(command -v yt-dlp))"
  elif [[ -x "$REPO/.monarch/bin/yt-dlp" ]]; then
    good "  yt-dlp in .monarch/bin (managed copy)"
  else
    warn "  no yt-dlp yet — the bot downloads it on the first /music play, or run: npm run music:setup"
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
    APP_URL_VAL="$(grep -E '^[[:space:]]*APP_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
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
  # gitignored, but on a laptop you also carry into cafés: a world-readable
  # file is one `ls` away from a stolen bot token.
  if [[ -n "$(find "$ENV_FILE" -perm /077 2>/dev/null)" ]]; then
    warn "  $ENV_FILE is group/world-readable and holds DISCORD_BOT_TOKEN — chmod 600 $ENV_FILE"
  fi
else
  bad "no env file at $ENV_FILE (cp .env.example .env, or pass --env-file)"
fi

# Two workers on one token is a real hazard, not a nicety: both receive every
# MessageCreate, so !burg and prefix commands fire twice, and two MusicManagers
# fight over one guild's voice channel.
if systemctl --user is-active --quiet "$UNIT_NAME" 2>/dev/null && [[ "$MODE" == "install" ]]; then
  note "an existing $UNIT_NAME is running — it will be restarted with the new unit"
fi
warn "still deployed on Render (or anywhere else)? Pause that service. render.yaml's worker and this one must not share DISCORD_BOT_TOKEN"

if command -v loginctl >/dev/null 2>&1 && [[ ! -d "/var/lib/systemd/linger/$USER" ]]; then
  warn "lingering is off — the unit starts at login, not at boot"
  note "fix (one time, needs sudo): sudo loginctl enable-linger $USER"
elif [[ -d "/var/lib/systemd/linger/$USER" ]]; then
  good "lingering on — the worker starts at boot, no login required"
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

# ── the unit ─────────────────────────────────────────────────────────────
step "Writing $UNIT_PATH"

# prism-media spawns ffmpeg as a child, so the service needs a real PATH even
# though systemd user units get a thin one.
NODE_DIR="$(dirname "$NODE_BIN")"
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
if [[ -n "$INHIBIT_BIN" ]] && "$INHIBIT_BIN" --what=sleep --who=monarch-bot-probe --why=probe --mode=block true 2>/dev/null; then
  # systemd splits ExecStart on whitespace *before* shell quoting rules apply,
  # so the quotes around --why are part of the unit file, and the binary has to
  # be an absolute path (systemd refuses a bare name).
  EXEC="$INHIBIT_BIN --what=$INHIBIT_WHAT --who=monarch-bot --why=\"Monarch Discord voice worker\" --mode=block $NODE_BIN"
  good "systemd-inhibit works — the laptop will not idle-suspend while the bot runs"
  if [[ "$HEADLESS" == "1" ]]; then
    warn "lid-close is refused too: stop the worker before you put the laptop in a bag"
  else
    note "lid close still suspends normally (bot just reconnects on wake) — add --headless to refuse it"
  fi
else
  EXEC="$NODE_BIN"
  [[ -n "$INHIBIT_BIN" ]] && warn "systemd-inhibit cannot reach logind here — running without it"
  warn "suspend is NOT blocked by the unit; the bot dies the moment the laptop sleeps. Do it in systemd instead:"
  note "sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target"
fi

UNIT="$(cat <<UNIT
# Generated by deploy/laptop-install.sh — edit the script, not this file.
#
# A user unit on purpose: no sudo, and \`systemctl --user\` / \`journalctl --user\`
# manage it. Starts at boot once lingering is enabled (sudo loginctl
# enable-linger $USER).
[Unit]
Description=Monarch — Discord bot worker (gateway + voice)
Documentation=file:$REPO/docs/hosting-laptop.md
# network-online.target is the honest one here: \`network.target\` only means
# sockets exist, which is true before DHCP has even finished. If the worker
# boots anyway, the login fails, start() exits 1, and Restart=always (below)
# tries again 10 s later — a slow router then costs 10 seconds instead of
# needing you.
After=network-online.target
Wants=network-online.target
# A 24/7 home worker should heal itself through an ISP outage, so systemd's
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
# Absolute PATH including node's own dir, so ffmpeg and any nvm install resolve.
Environment=PATH=$NODE_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
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
# One node process + one ffmpeg per *playing* guild, on an always-on laptop that
# is also your desktop: stay bounded so the worker can't eat the machine.
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
  systemctl --user enable --now "$UNIT_NAME"
  good "enabled + started"
  sleep 2
  printf '\n'
  systemctl --user --no-pager --full status "$UNIT_NAME" | sed 's/^/  /' || true
  printf '\n%s\n' "Watch it: journalctl --user -u $UNIT_NAME -f"
  note "look for: bot ready  { instance: \"$HOSTNAME\", guilds: N, burg: true, prefixCommands: true }"
  note "then in Discord: /music play <song> — voice is UDP, and this box allows it"
else
  printf '  %s[dry-run]%s systemctl --user daemon-reload && systemctl --user enable --now %s\n' "$DIM" "$OFF" "$UNIT_NAME"
fi
