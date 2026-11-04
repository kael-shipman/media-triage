#!/bin/sh
# Installs or upgrades media-triage: https://github.com/kael-shipman/media-triage
#
#   curl -fsSL https://raw.githubusercontent.com/kael-shipman/media-triage/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/kael-shipman/media-triage/main/install.sh | sh -s -- --service user
#
# Safe to run again: it replaces the executable, and never touches an existing configuration.
set -eu

REPO="https://github.com/kael-shipman/media-triage"
VERSION=""
PREFIX="${HOME}/.local/bin"
SERVICE="none"
PRERELEASE=0

usage() {
  cat <<'EOF'
Installs or upgrades media-triage.

Usage: install.sh [options]

Options:
  --version vX.Y.Z               The release to install (default: the newest)
  --prefix DIR                   Where the executable goes (default: ~/.local/bin)
  --repo URL                     Where releases come from (default: https://github.com/kael-shipman/media-triage)
  --service none|user|system     Also install a systemd unit (default: none). "system" needs sudo, and runs the
                                 daemon as you
  --prerelease                   Allow a pre-release when picking the newest
  -h, --help                     Print this help
EOF
}

say() { printf '%s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION="$2"; shift 2 ;;
    --prefix) [ $# -ge 2 ] || die "--prefix needs a value"; PREFIX="$2"; shift 2 ;;
    --repo) [ $# -ge 2 ] || die "--repo needs a value"; REPO="${2%/}"; shift 2 ;;
    --service) [ $# -ge 2 ] || die "--service needs a value"; SERVICE="$2"; shift 2 ;;
    --prerelease) PRERELEASE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

case "$SERVICE" in none | user | system) ;; *) die "--service must be none, user or system" ;; esac

# --- This machine -----------------------------------------------------------------------------------------------

[ "$(uname -s)" = "Linux" ] || die "media-triage runs on Linux only, for now"
case "$(uname -m)" in
  x86_64 | amd64) ARCH="x64" ;;
  aarch64 | arm64) ARCH="arm64" ;;
  *) die "there's no media-triage build for $(uname -m)" ;;
esac
ASSET="media-triage-linux-${ARCH}"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL -H "User-Agent: media-triage-installer" "$1"; }
  fetch_to() { curl -fsSL -H "User-Agent: media-triage-installer" -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO- --header "User-Agent: media-triage-installer" "$1"; }
  fetch_to() { wget -qO "$2" --header "User-Agent: media-triage-installer" "$1"; }
else
  die "this needs curl or wget"
fi

if command -v sha256sum >/dev/null 2>&1; then
  hash_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  hash_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "this needs sha256sum or shasum"
fi

# --- Which release ----------------------------------------------------------------------------------------------

# The REST API: github.com's, or a GitHub Enterprise server's.
HOST_AND_SCHEME=$(printf '%s' "$REPO" | sed -n 's|^\(https\{0,1\}://[^/]*\)/.*|\1|p')
REPO_PATH=$(printf '%s' "$REPO" | sed -n 's|^https\{0,1\}://[^/]*/\([^/]*/[^/]*\)$|\1|p' | sed 's|\.git$||')
[ -n "$HOST_AND_SCHEME" ] && [ -n "$REPO_PATH" ] || die "$REPO isn't a repository URL like https://github.com/owner/repo"
if [ "$HOST_AND_SCHEME" = "https://github.com" ]; then API="https://api.github.com"; else API="${HOST_AND_SCHEME}/api/v3"; fi

tag_names() { sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p'; }

if [ -z "$VERSION" ]; then
  if [ "$PRERELEASE" = 1 ]; then
    # The newest release of any kind, drafts aside (the API lists the newest first and hides drafts from others).
    VERSION=$(fetch "${API}/repos/${REPO_PATH}/releases?per_page=1" | tag_names | head -n 1)
  else
    VERSION=$(fetch "${API}/repos/${REPO_PATH}/releases/latest" | tag_names | head -n 1)
  fi
  [ -n "$VERSION" ] || die "couldn't find a release of $REPO"
fi
case "$VERSION" in v*) ;; *) VERSION="v${VERSION}" ;; esac
EXPECTED_OUTPUT="media-triage ${VERSION#v}"

# --- Download and check -----------------------------------------------------------------------------------------

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

say "Downloading media-triage ${VERSION} (${ASSET})"
fetch_to "${REPO}/releases/download/${VERSION}/${ASSET}" "${WORK}/${ASSET}" || die "release ${VERSION} has no ${ASSET}"
fetch_to "${REPO}/releases/download/${VERSION}/SHA256SUMS" "${WORK}/SHA256SUMS" || die "release ${VERSION} has no SHA256SUMS"

EXPECTED_HASH=$(sed -n "s/^\([0-9a-fA-F]\{64\}\) [ *]${ASSET}\$/\1/p" "${WORK}/SHA256SUMS" | tr 'A-F' 'a-f')
[ -n "$EXPECTED_HASH" ] || die "SHA256SUMS has no line for ${ASSET}"
[ "$(hash_of "${WORK}/${ASSET}")" = "$EXPECTED_HASH" ] || die "${ASSET} doesn't match its checksum"

chmod 755 "${WORK}/${ASSET}"
OUTPUT=$("${WORK}/${ASSET}" version 2>&1) || die "the downloaded executable doesn't run: ${OUTPUT}"
[ "$OUTPUT" = "$EXPECTED_OUTPUT" ] || die "the downloaded executable says \"${OUTPUT}\", not \"${EXPECTED_OUTPUT}\""

# --- Install ----------------------------------------------------------------------------------------------------

mkdir -p "$PREFIX"
TARGET="${PREFIX}/media-triage"
# Copy next to the target first, so the final rename is atomic even if a daemon is running it.
cp "${WORK}/${ASSET}" "${TARGET}.new"
mv -f "${TARGET}.new" "$TARGET"
say "Installed ${TARGET} (${VERSION})"

case ":${PATH}:" in
  *":${PREFIX}:"*) ;;
  *) warn "${PREFIX} isn't on your PATH; add it, or run ${TARGET} by its full path" ;;
esac

"$TARGET" init

command -v exiftool >/dev/null 2>&1 ||
  warn "exiftool isn't installed, and media-triage needs it (Debian and Ubuntu: sudo apt install libimage-exiftool-perl)"

# --- Service ----------------------------------------------------------------------------------------------------

unit() {
  # $1: extra [Service] lines. $2: the [Install] target.
  cat <<EOF
[Unit]
Description=media-triage: keeps a photo inbox, an archive, Immich and Darktable in step
Documentation=https://github.com/kael-shipman/media-triage
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${TARGET} run
${1}# It exits with status 75 after upgrading itself; restarting starts the new version.
Restart=always
RestartSec=10

[Install]
WantedBy=${2}
EOF
}

case "$SERVICE" in
  user)
    UNIT_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
    mkdir -p "$UNIT_DIR"
    unit "" "default.target" >"${UNIT_DIR}/media-triage.service"
    systemctl --user daemon-reload
    systemctl --user enable media-triage.service
    systemctl --user try-restart media-triage.service
    say "Installed the user service ${UNIT_DIR}/media-triage.service."
    say "To run it while you're logged out: sudo loginctl enable-linger $(id -un)"
    SYSTEMCTL="systemctl --user"
    ;;
  system)
    unit "User=$(id -un)
Group=$(id -gn)
" "multi-user.target" | sudo tee /etc/systemd/system/media-triage.service >/dev/null
    sudo systemctl daemon-reload
    sudo systemctl enable media-triage.service
    sudo systemctl try-restart media-triage.service
    say "Installed the system service /etc/systemd/system/media-triage.service, running as $(id -un)."
    SYSTEMCTL="sudo systemctl"
    ;;
esac

say ""
say "Next: edit the configuration, check it with \`media-triage config\`, and log in to each Immich account with"
say "\`media-triage login <name>\`."
if [ "$SERVICE" != "none" ]; then
  say "Then start the service: ${SYSTEMCTL} start media-triage"
fi
