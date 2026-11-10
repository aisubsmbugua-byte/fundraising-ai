#!/usr/bin/env bash
# Item 114, authorized by ruling 0046 clause 2: set up a fresh Ubuntu 24.04 server (an AWS
# Lightsail instance, 8 GB RAM / 2 vCPU / 160 GB disk, later perhaps 4 GB / 80 GB) to load
# the funder reference database for every state, unattended, and keep it current monthly.
#
# FOR THE OWNER. Run this ONCE in the Lightsail browser terminal:
#
#     bash setup-funder-loader.sh            (it asks for sudo itself)
#
# It is safe to run again: every step looks at what is already done and skips it, so after
# a dropped connection or a failed download you simply run it again. To see what it would
# do, touching nothing:   bash setup-funder-loader.sh --check
#
# What it does, in order:
#   1. checks the machine (Ubuntu 24.04, memory, and at least 60 GB free disk: it REFUSES
#      to go on with less, before it installs or downloads anything);
#   2. installs what is needed: git, curl, and Node.js 22 (the current long-term-support
#      line that this loader was written and tested on; from NodeSource's apt repository);
#   3. adds a 4 GB swap file as a safety net (the loader needs about 1.5 GB, so it should
#      never use it);
#   4. creates a dedicated user with no login (funder-loader) that owns everything below;
#   5. makes an SSH key on this server for that user, shows you the PUBLIC half, tells you
#      exactly where to paste it in GitHub (a read-only deploy key on the repository), waits
#      for you to press Enter, and then downloads the code. No GitHub password or token is
#      asked for or stored;
#   6. asks you for the Supabase secret key made for this loader (typing is hidden), checks
#      it starts sb_secret_, and stores it ONLY in /etc/funder-loader.env, readable by root
#      alone. It is never printed, never on a command line, never in a log;
#   7. downloads the IRS bulk files (about 19 GB; resumable) with the project's own fetch
#      script;
#   8. installs the systemd service (runs the all-states command; restarts itself after a
#      crash or reboot and resumes) and the monthly timer (fetches only new IRS archives and
#      runs the same command; it will not start until you have started the first load).
# It does NOT start the first load. At the end it prints the one command that does, and the
# three you need afterwards (follow progress, see the last status, stop).
#
# Options:
#   --check            print what would be done; change nothing
#   --skip-download    do everything but step 7 (download later by running this again)
#   --key-from-stdin   read the Supabase key from standard input instead of the hidden prompt
#   --only STEPS       run only these steps, comma separated: checks,packages,swap,user,code,
#                      deps,env,download,units  (for repair; "units" re-writes the service files)
#   --env-file PATH    where to store the key (default /etc/funder-loader.env)
#   --print-units DIR  write the systemd unit files into DIR and stop (used by the tests)
#   --repo URL         the repository (default: the project's private GitHub repository)
#
# NOT VERIFIED ON A REAL SERVER when this was written (it was written and syntax-checked on a
# Mac): the NodeSource repository commands, the apt package names, systemd's behaviour. The
# first run on the server is the test; every step prints what it is doing and stops at the
# first error rather than carrying on.

set -euo pipefail
set +x # never trace: a trace would print the key

# --------------------------------------------------------------------------- settings
REPO_URL="git@github.com:aisubsmbugua-byte/fundraising-ai.git"
REPO_WEB="https://github.com/aisubsmbugua-byte/fundraising-ai"
SUPABASE_URL="https://mbsxeyoxojcqetrmwgba.supabase.co"
NODE_MAJOR="22"
NODE_HEAP_MB="1536"
SVC_USER="funder-loader"
HOME_DIR="/var/lib/funder-loader"
APP_DIR="/opt/funder-loader/app"
DATA_DIR="$HOME_DIR/data"
WORK_DIR="$HOME_DIR/work"
ENV_FILE="/etc/funder-loader.env"
UNIT_DIR="/etc/systemd/system"
SWAP_FILE="/swapfile"
SWAP_GB="4"
MIN_FREE_GB="60"
TSX_VERSION="4.21.0"
# GitHub's published SSH host key (api.github.com/meta, "ssh_keys", ed25519). Pinned here so the
# connection is checked against a known key instead of trusting whatever answers first.
GITHUB_HOSTKEY="github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"

CHECK=0
SKIP_DOWNLOAD=0
KEY_FROM_STDIN=0
ONLY=""
PRINT_UNITS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --skip-download) SKIP_DOWNLOAD=1 ;;
    --key-from-stdin) KEY_FROM_STDIN=1 ;;
    --only) ONLY="${2:-}"; shift ;;
    --env-file) ENV_FILE="${2:-}"; shift ;;
    --print-units) PRINT_UNITS="${2:-}"; shift ;;
    --repo) REPO_URL="${2:-}"; shift ;;
    -h|--help) sed -n '2,50p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)"; exit 2 ;;
  esac
  shift
done

# --------------------------------------------------------------------------- helpers
say() { printf '%s\n' "$*"; }
step() { printf '\n== %s ==\n' "$*"; }
want() { # is this step selected?
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; esac
  return 1
}
# run a command, or in --check mode only say what would run
act() {
  if [ "$CHECK" = 1 ]; then printf 'WOULD: %s\n' "$*"; else "$@"; fi
}
# run as the service user: it has no login shell, so use runuser, and give it its own HOME
# (runuser keeps the caller's, which would send ssh, git and npm to root's folders)
as_svc() {
  if [ "$CHECK" = 1 ]; then printf 'WOULD (as %s): %s\n' "$SVC_USER" "$*"; return 0; fi
  runuser -u "$SVC_USER" -- env "HOME=$HOME_DIR" "$@"
}
# free space in GB on the filesystem that holds $1 (or its nearest existing parent: the folder may not exist yet)
free_gb() {
  local p="$1"
  while [ ! -e "$p" ] && [ "$p" != "/" ]; do p="$(dirname "$p")"; done
  { df -Pk "$p" 2>/dev/null || true; } | awk 'NR==2 {printf "%d", $4/1048576}'
}
mem_mb() { awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0; }

# --------------------------------------------------------------------------- the unit files
render_units() { # $1 = directory to write into
  local d="$1" mem mm
  mem="$(mem_mb)"; [ "$mem" -gt 0 ] || mem=4096
  mm=$(( mem * 80 / 100 ))
  mkdir -p "$d"
  cat > "$d/funder-loader.service" <<UNIT
# Written by scripts/server/setup-funder-loader.sh (item 114, ruling 0046). Re-running that script rewrites this file.
[Unit]
Description=Funder reference loader: load every state, check a sample, keep current
Documentation=$REPO_WEB
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=3600
StartLimitBurst=5

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$APP_DIR
# the Supabase key and the memory setting live ONLY in this file (root-readable, mode 600)
EnvironmentFile=$ENV_FILE
Environment=HOME=$HOME_DIR
ExecStart=$APP_DIR/scripts/server/funder-loader-run.sh
# Resume after a crash, a kill or a reboot. NOT after a deliberate stop (exit 1: a sample difference
# nobody has explained; 2: bad configuration; 3: a state failed its retries; 4: another copy running):
# those wait for a person, and the run table says why. Exit 5 (a download failed) is retried.
Restart=on-failure
RestartSec=120
RestartPreventExitStatus=1 2 3 4
SuccessExitStatus=0
# a stop signal lets the command write "interrupted" to the run table before it exits
TimeoutStopSec=120
KillMode=mixed
# a runaway is stopped here rather than taking the whole machine down (80% of RAM)
MemoryMax=${mm}M
Nice=10
# it reads and writes only its own folders
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$HOME_DIR
UNIT
  cat > "$d/funder-loader-refresh.service" <<UNIT
# Written by scripts/server/setup-funder-loader.sh. The monthly timer starts THIS, which starts the
# loader only if the first load has been started by a person (the work folder has its manifest).
[Unit]
Description=Monthly refresh of the funder reference database (starts funder-loader.service)
ConditionPathExists=$WORK_DIR/all-states-manifest.json

[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl start --no-block funder-loader.service
UNIT
  cat > "$d/funder-loader-refresh.timer" <<UNIT
# Written by scripts/server/setup-funder-loader.sh. Monthly: new IRS archives are fetched, then the
# same command as the first load runs and reloads only the states whose filings changed.
[Unit]
Description=Monthly refresh of the funder reference database

[Timer]
OnCalendar=*-*-15 03:30:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
UNIT
}

if [ -n "$PRINT_UNITS" ]; then
  render_units "$PRINT_UNITS"
  say "wrote the unit files into $PRINT_UNITS"
  exit 0
fi

# --------------------------------------------------------------------------- root
if [ "$CHECK" = 0 ] && [ "$(id -u)" != 0 ] && [ -z "${FUNDER_SETUP_ALLOW_NON_ROOT:-}" ]; then
  say "This needs administrator rights; asking for sudo (you may be asked for your password)."
  exec sudo -E bash "$0" "$@"
fi

[ "$CHECK" = 1 ] && say "CHECK MODE: nothing below is changed; each line says what would be done."

# --------------------------------------------------------------------------- 1. checks
if want checks; then
  step "1. the machine"
  OSID=""; OSVER=""
  if [ -r /etc/os-release ]; then OSID="$(. /etc/os-release; echo "${ID:-}")"; OSVER="$(. /etc/os-release; echo "${VERSION_ID:-}")"; fi
  if [ "$OSID" = ubuntu ] && [ "$OSVER" = "24.04" ]; then
    say "Ubuntu 24.04: ok"
  elif [ "$CHECK" = 1 ]; then
    say "this machine is not Ubuntu 24.04 (${OSID:-unknown} ${OSVER:-}); a real run would refuse here"
  else
    say "This script is written for Ubuntu 24.04 and this is ${OSID:-unknown} ${OSVER:-}. Stopping; nothing was changed."; exit 1
  fi
  say "memory: $(mem_mb) MB (the loader needs about 1500 MB; the service is capped at 80% of this)"
  CHECK_PATH="/var/lib"; [ -d "$CHECK_PATH" ] || CHECK_PATH="/"
  FREE="$(free_gb "$CHECK_PATH")"
  say "free disk where the IRS files will live: ${FREE:-?} GB (needs at least $MIN_FREE_GB GB)"
  if [ -n "$FREE" ] && [ "$FREE" -lt "$MIN_FREE_GB" ]; then
    if [ "$CHECK" = 1 ]; then say "a real run would REFUSE here: less than $MIN_FREE_GB GB free"; else say "Not enough free disk (need $MIN_FREE_GB GB). Stopping before anything is installed or downloaded."; exit 1; fi
  fi
fi

# --------------------------------------------------------------------------- 2. packages and node
if want packages; then
  step "2. software (git, curl, Node.js $NODE_MAJOR)"
  if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" = "$NODE_MAJOR" ]; then
    say "Node.js $NODE_MAJOR already installed ($(node --version))"
  else
    act apt-get update
    act env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg git openssh-client
    act mkdir -p /etc/apt/keyrings
    if [ "$CHECK" = 1 ]; then
      say "WOULD: add the NodeSource apt repository for node_$NODE_MAJOR.x (key from https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key) and apt-get install -y nodejs"
    else
      curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
      say "installed Node.js $(node --version)"
    fi
  fi
fi

# --------------------------------------------------------------------------- 3. swap
if want swap; then
  step "3. a ${SWAP_GB} GB swap file (a safety net)"
  if swapon --show=NAME --noheadings 2>/dev/null | grep -q "^$SWAP_FILE\$"; then
    say "$SWAP_FILE is already in use"
  else
    if [ ! -f "$SWAP_FILE" ]; then
      act fallocate -l "${SWAP_GB}G" "$SWAP_FILE"
      act chmod 600 "$SWAP_FILE"
      act mkswap "$SWAP_FILE"
    fi
    act swapon "$SWAP_FILE"
  fi
  if ! grep -qs "^$SWAP_FILE " /etc/fstab; then
    if [ "$CHECK" = 1 ]; then say "WOULD: add $SWAP_FILE to /etc/fstab so it survives a reboot"; else echo "$SWAP_FILE none swap sw 0 0" >> /etc/fstab; fi
  fi
  if [ ! -f /etc/sysctl.d/99-funder-loader.conf ]; then
    if [ "$CHECK" = 1 ]; then say "WOULD: set vm.swappiness=10 (use swap only when memory is nearly gone)"; else echo "vm.swappiness=10" > /etc/sysctl.d/99-funder-loader.conf; sysctl -q -p /etc/sysctl.d/99-funder-loader.conf || true; fi
  fi
fi

# --------------------------------------------------------------------------- 4. user and folders
if want user; then
  step "4. a dedicated user and its folders"
  if id "$SVC_USER" >/dev/null 2>&1; then
    say "user $SVC_USER already exists"
  else
    act useradd --system --create-home --home-dir "$HOME_DIR" --shell /usr/sbin/nologin "$SVC_USER"
  fi
  act mkdir -p "$DATA_DIR" "$WORK_DIR" "$(dirname "$APP_DIR")"
  if [ "$CHECK" = 0 ]; then
    chown "$SVC_USER:$SVC_USER" "$HOME_DIR" "$DATA_DIR" "$WORK_DIR" "$(dirname "$APP_DIR")"
    chmod 750 "$HOME_DIR"
  fi
fi

# --------------------------------------------------------------------------- 5. the code, by deploy key
if want code; then
  step "5. the code (a read-only deploy key; no GitHub password or token)"
  SSH_DIR="$HOME_DIR/.ssh"
  KEY="$SSH_DIR/id_ed25519"
  as_svc mkdir -p "$SSH_DIR"
  act chmod 700 "$SSH_DIR"
  if [ "$CHECK" = 0 ] && [ ! -f "$SSH_DIR/known_hosts" ]; then
    printf '%s\n' "$GITHUB_HOSTKEY" | as_svc tee "$SSH_DIR/known_hosts" >/dev/null
  elif [ "$CHECK" = 1 ]; then
    say "WOULD: pin GitHub's published SSH host key in $SSH_DIR/known_hosts (checked against api.github.com/meta)"
  fi
  if [ ! -f "$KEY" ]; then
    as_svc ssh-keygen -q -t ed25519 -N "" -C "$SVC_USER@$(hostname)" -f "$KEY"
  else
    say "the server's deploy key already exists"
  fi
  GIT_SSH="ssh -i $KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$SSH_DIR/known_hosts -o StrictHostKeyChecking=yes"
  have_access() { as_svc env GIT_SSH_COMMAND="$GIT_SSH" git ls-remote "$REPO_URL" HEAD >/dev/null 2>&1; }
  if [ "$CHECK" = 1 ]; then
    say "WOULD: print the public key and these instructions, then wait for you to press Enter:"
    say "  In GitHub open $REPO_WEB -> Settings -> Deploy keys -> Add deploy key."
    say "  Title: funder-loader (Lightsail). Key: paste the line above. Leave 'Allow write access' UNCHECKED. Click Add key."
  else
    until have_access; do
      say ""
      say "Add this PUBLIC key to GitHub so this server can download the code (read-only):"
      say ""
      cat "$KEY.pub"
      say ""
      say "  1. Open $REPO_WEB"
      say "  2. Settings  ->  Deploy keys  ->  Add deploy key"
      say "  3. Title: funder-loader (Lightsail).  Key: paste the line printed above."
      say "  4. Leave 'Allow write access' UNCHECKED (the server only reads).  Click 'Add key'."
      printf 'Press Enter when you have added it (or Ctrl-C to stop; run this script again later): '
      read -r _ </dev/tty
    done
    say "GitHub accepted the key."
  fi
  if [ -d "$APP_DIR/.git" ]; then
    say "the code is already at $APP_DIR; updating it to the latest main"
    if [ "$CHECK" = 0 ]; then as_svc env GIT_SSH_COMMAND="$GIT_SSH" git -C "$APP_DIR" pull --ff-only; fi
  else
    if [ "$CHECK" = 1 ]; then say "WOULD: git clone $REPO_URL into $APP_DIR"; else as_svc env GIT_SSH_COMMAND="$GIT_SSH" git clone --branch main "$REPO_URL" "$APP_DIR"; fi
  fi
  [ "$CHECK" = 1 ] || say "code version: $(as_svc git -C "$APP_DIR" log -1 --format='%h %s' 2>/dev/null || echo unknown)"
fi

# --------------------------------------------------------------------------- 5b. dependencies
if want deps; then
  step "5b. the project's libraries (production ones only, plus the script runner)"
  if [ -x "$APP_DIR/node_modules/.bin/tsx" ] && [ -d "$APP_DIR/node_modules/@supabase" ]; then
    say "already installed"
  else
    as_svc bash -c "cd '$APP_DIR' && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm install --no-save --no-package-lock --omit=dev --ignore-scripts --no-audit --no-fund tsx@$TSX_VERSION"
  fi
fi

# --------------------------------------------------------------------------- 6. the key
if want env; then
  step "6. the Supabase secret key (stored only in $ENV_FILE)"
  existing=0
  if [ -f "$ENV_FILE" ] && grep -q '^SUPABASE_SERVICE_ROLE_KEY=sb_secret_' "$ENV_FILE" 2>/dev/null; then existing=1; fi
  newkey=""
  if [ "$CHECK" = 1 ]; then
    say "WOULD: ask for the dedicated Supabase secret key with typing hidden, require it to start sb_secret_, and write it to $ENV_FILE (owner root, mode 600) together with"
    say "       NEXT_PUBLIC_SUPABASE_URL=$SUPABASE_URL  and  NODE_OPTIONS=--max-old-space-size=$NODE_HEAP_MB"
    [ "$existing" = 1 ] && say "       (a key is already stored there; a real run would offer to keep it)"
  else
    if [ "$KEY_FROM_STDIN" = 1 ]; then
      IFS= read -r newkey || true
    elif [ "$existing" = 1 ]; then
      say "A key is already stored in $ENV_FILE."
      read -r -s -p "Press Enter to keep it, or paste a new Supabase secret key (hidden) to replace it: " newkey </dev/tty; echo
    else
      say "Create a key made for this loader alone: Supabase dashboard -> Project Settings -> API Keys -> create a new secret key named funder-loader."
      say "Do not use the application's key. It starts sb_secret_."
      read -r -s -p "Paste the key, then press Enter (nothing is shown): " newkey </dev/tty; echo
    fi
    if [ -z "$newkey" ] && [ "$existing" = 1 ]; then
      say "keeping the stored key"
    else
      case "$newkey" in
        sb_secret_*) ;;
        *) unset newkey; say "That is not a key starting sb_secret_ (a legacy eyJ key is rejected by this project). Nothing was stored."; exit 2 ;;
      esac
      if ! printf '%s' "$newkey" | grep -Eq '^sb_secret_[A-Za-z0-9_-]+$'; then unset newkey; say "The key has characters a key never has; paste it again. Nothing was stored."; exit 2; fi
    fi
    if [ -n "$newkey" ] || [ "$existing" = 0 ]; then
      umask 077
      tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
      {
        printf 'NEXT_PUBLIC_SUPABASE_URL=%s\n' "$SUPABASE_URL"
        printf 'SUPABASE_SERVICE_ROLE_KEY=%s\n' "$newkey"
        printf 'NODE_OPTIONS=--max-old-space-size=%s\n' "$NODE_HEAP_MB"
      } > "$tmp"
      chmod 600 "$tmp"
      if [ "$(id -u)" = 0 ]; then chown root:root "$tmp"; fi
      mv -f "$tmp" "$ENV_FILE"
      unset newkey tmp
      say "stored in $ENV_FILE (mode 600, owner root); not shown"
    fi
    unset newkey
    # an existing file kept as it is still gets the current URL and memory setting, without touching the key line
    if [ "$existing" = 1 ] && [ -f "$ENV_FILE" ]; then
      chmod 600 "$ENV_FILE"
      grep -q "^NODE_OPTIONS=--max-old-space-size=$NODE_HEAP_MB\$" "$ENV_FILE" || { sed -i.bak "/^NODE_OPTIONS=/d" "$ENV_FILE" && rm -f "$ENV_FILE.bak" && printf 'NODE_OPTIONS=--max-old-space-size=%s\n' "$NODE_HEAP_MB" >> "$ENV_FILE"; }
    fi
  fi
fi

# --------------------------------------------------------------------------- 7. the IRS files
if want download; then
  step "7. the IRS bulk files (about 19 GB; resumable)"
  if [ "$SKIP_DOWNLOAD" = 1 ]; then
    say "skipped (--skip-download); run this script again, or the service's first start, to fetch them"
  else
    FREE="$(free_gb "${HOME_DIR}")"; [ -n "$FREE" ] || FREE="$(free_gb /)"
    if [ -n "$FREE" ] && [ "$FREE" -lt "$MIN_FREE_GB" ]; then
      if [ "$CHECK" = 1 ]; then say "a real run would REFUSE to download: $FREE GB free, need $MIN_FREE_GB GB"; else say "Only $FREE GB free; need $MIN_FREE_GB GB. Not downloading."; exit 1; fi
    fi
    # the index files only when they are not all on disk yet (a re-run must not compare them again);
    # the archives always (resumable)
    if [ "$CHECK" = 0 ] && [ "$(ls "$DATA_DIR"/index/index_*.csv 2>/dev/null | wc -l)" -ge 5 ]; then
      say "the index files are already on disk"
    else
      as_svc bash -c "cd '$APP_DIR' && './node_modules/.bin/tsx' scripts/fetch-funder-reference-sources.ts --out '$DATA_DIR' --index-only --parallel 2"
    fi
    as_svc bash -c "cd '$APP_DIR' && './node_modules/.bin/tsx' scripts/fetch-funder-reference-sources.ts --out '$DATA_DIR' --zips-only --parallel 2"
  fi
fi

# --------------------------------------------------------------------------- 8. the service and the timer
if want units; then
  step "8. the service and the monthly timer"
  if [ "$CHECK" = 1 ]; then
    say "WOULD: write $UNIT_DIR/funder-loader.service, funder-loader-refresh.service and funder-loader-refresh.timer, run systemctl daemon-reload,"
    say "       and enable the timer. The service itself is NOT started."
  else
    render_units "$UNIT_DIR"
    systemctl daemon-reload
    systemctl enable funder-loader-refresh.timer >/dev/null
    systemctl start funder-loader-refresh.timer
    say "installed. The timer is on (15th of each month, 03:30) but does nothing until you have started the first load."
  fi
fi

# --------------------------------------------------------------------------- the end
step "done"
if [ "$CHECK" = 1 ]; then
  say "That was a check only: nothing was changed."
else
  say "Setup finished. The first load has NOT been started."
fi
cat <<MSG

Before you start it, look at the state of things:
    sudo $APP_DIR/scripts/server/funder-loader-status.sh        (reads the run table: nothing has run yet)

Start the first load (all states; several hours; safe to stop and start again):
    sudo systemctl start funder-loader

The three commands you will want afterwards:
    follow what it is doing, live:     sudo journalctl -u funder-loader -f
    see the last status (from the database):  sudo $APP_DIR/scripts/server/funder-loader-status.sh
    stop it (it resumes where it left off when started again):  sudo systemctl stop funder-loader

If it stops by itself with an unexplained difference, the status command says which state and what
was different; nothing after that state was touched.
MSG
