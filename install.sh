#!/usr/bin/env bash
# Qurp installer: ./install.sh --help
set -euo pipefail

UUID="qurp@gnome-shell-extension"
EXT_ROOT="${XDG_DATA_HOME:-${HOME}/.local/share}/gnome-shell/extensions"
DEST="${EXT_ROOT}/${UUID}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_DEST="/usr/local/libexec/qurp-helper"
POLICY_DEST="/usr/share/polkit-1/actions/org.qurp.helper.policy"
CORE_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/qurp/bin"       # private sing-box copy (TUN)
CORE_COPY="${CORE_DIR}/sing-box"
CORE_INSTALL_DIR="${QURP_CORE_DIR:-/usr/local/bin}"               # where --install-core puts sing-box
MIN_MAJOR=1
MIN_MINOR=12

WITH_HELPER=0
WITH_TUN=0
WITH_CORE=0
CHECK_ONLY=0
UNINSTALL=0
ASSUME_YES=0
NO_COLOR_FLAG=0

usage() {
  cat <<EOF
Usage: ./install.sh [options]

  (no options)    install the extension
  --install-core  download the official sing-box release and install it (to ${CORE_INSTALL_DIR})
  --helper        install the kill switch helper + polkit policy (needs sudo)
  --tun           TUN mode: private owner-only copy of sing-box with network capabilities (needs sudo)
  --all           --helper and --tun
  --check         only check your system, change nothing
  --uninstall     remove the extension, the helper, the private sing-box copy and kill switch rules
  --options       show all optional flags with a short description (this table)
  -y, --yes       do not ask questions (answer yes)
  --no-color      plain output
  -h, --help      this help
EOF
}

show_options() {
  cat <<EOF

Optional install flags
──────────────────────────────────────────────────────────────
  ./install.sh --helper         Kill switch (nftables + polkit). Needs sudo.
  ./install.sh --tun            TUN mode: private sing-box copy with network
                                capabilities. Needs sudo + setcap.
  ./install.sh --all            Both --helper and --tun.
  ./install.sh --install-core   Download & install official sing-box binary
                                into ${CORE_INSTALL_DIR}.
  ./install.sh --check          Only check the system; install nothing.
  ./install.sh --uninstall      Remove extension, helper, private sing-box
                                copy and leftover kill-switch rules.
  ./install.sh -y / --yes       Answer yes to prompts (non-interactive).
  ./install.sh --no-color       Plain output (no colors / Unicode symbols).
  ./install.sh --options        Show this table.
  ./install.sh -h / --help      Short usage summary.

Typical full setup:
  ./install.sh --all            # extension + kill switch + TUN
  # then log out / back in (or Alt+F2 → r on X11)
  gnome-extensions enable qurp@gnome-shell-extension

EOF
}

for arg in "$@"; do
  case "$arg" in
    --install-core) WITH_CORE=1 ;;
    --helper)       WITH_HELPER=1 ;;
    --tun)          WITH_TUN=1 ;;
    --all)          WITH_HELPER=1; WITH_TUN=1 ;;
    --check)        CHECK_ONLY=1 ;;
    --uninstall)    UNINSTALL=1 ;;
    -y|--yes)       ASSUME_YES=1 ;;
    --no-color)     NO_COLOR_FLAG=1 ;;
    --options)      show_options; exit 0 ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "unknown option: $arg" >&2; usage >&2; exit 64 ;;
  esac
done

# ------------------------------------------------------------------ output
B=; D=; R=; G=; Y=; C=; Z=
if [[ -t 1 && -z "${NO_COLOR:-}" && $NO_COLOR_FLAG -eq 0 ]]; then
  B=$'\033[1m'; D=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; Z=$'\033[0m'
fi
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) S_OK="✔"; S_BAD="✘"; S_WARN="⚠"; S_ARROW="➜"; S_RULE="─" ;;
  *)                                S_OK="+"; S_BAD="x"; S_WARN="!"; S_ARROW="->"; S_RULE="-" ;;
esac

rule() {
  local i line=""
  for ((i = 0; i < 64; i++)); do line+="$S_RULE"; done
  printf '%s%s%s\n' "$D" "$line" "$Z"
}
ok()    { printf '  %s%s%s %s\n' "$G" "$S_OK" "$Z" "$*"; }
bad()   { printf '  %s%s%s %s%s%s\n' "$R" "$S_BAD" "$Z" "$B" "$*" "$Z"; }
warn()  { printf '  %s%s%s %s\n' "$Y" "$S_WARN" "$Z" "$*"; }
note()  { printf '    %s%s%s\n' "$D" "$*" "$Z"; }
cmd()   { printf '      %s$ %s%s\n' "$C" "$*" "$Z"; }
step()  { printf '\n%s%s[%s/%s]%s %s%s%s\n' "$B" "$C" "$1" "$2" "$Z" "$B" "$3" "$Z"; }
die()   { printf '\n  %s%s ERROR:%s %s\n\n' "$R" "$S_BAD" "$Z" "$*" >&2; exit 1; }

CORE_TMP=""
cleanup() { if [[ -n "$CORE_TMP" ]]; then rm -rf "$CORE_TMP"; fi; }
trap cleanup EXIT

DONE=()      # what was installed
ATTN=()      # what still needs the user's attention
NEXT=()      # numbered next steps

# ------------------------------------------------------------------ helpers
run_root() {
  if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi
}

distro_family() {
  local ids
  ids="$( ( . /etc/os-release 2>/dev/null; echo " ${ID:-} ${ID_LIKE:-} " ) 2>/dev/null || true)"
  case "$ids" in
    *" fedora "*|*" rhel "*|*" centos "*) echo fedora ;;
    *" debian "*|*" ubuntu "*)           echo debian ;;
    *" arch "*)                          echo arch ;;
    *" suse "*|*" opensuse "*)           echo suse ;;
    *)                                   echo unknown ;;
  esac
}

# prints the command that installs the given logical package on this distribution (best effort)
pkg_cmd() {
  case "$(distro_family):$1" in
    fedora:nftables)  echo "sudo dnf install nftables" ;;
    fedora:polkit)    echo "sudo dnf install polkit" ;;
    fedora:libcap)    echo "sudo dnf install libcap" ;;
    fedora:glib)      echo "sudo dnf install glib2-devel" ;;
    debian:nftables)  echo "sudo apt install nftables" ;;
    debian:polkit)    echo "sudo apt install policykit-1" ;;
    debian:libcap)    echo "sudo apt install libcap2-bin" ;;
    debian:glib)      echo "sudo apt install libglib2.0-bin" ;;
    arch:nftables)    echo "sudo pacman -S nftables" ;;
    arch:polkit)      echo "sudo pacman -S polkit" ;;
    arch:libcap)      echo "sudo pacman -S libcap" ;;
    arch:glib)        echo "sudo pacman -S glib2" ;;
    suse:nftables)    echo "sudo zypper install nftables" ;;
    suse:polkit)      echo "sudo zypper install polkit" ;;
    suse:libcap)      echo "sudo zypper install libcap-progs" ;;
    suse:glib)        echo "sudo zypper install glib2-tools" ;;
    *)                echo "" ;;
  esac
}

# same places the extension searches: the shell's PATH is often shorter than a terminal's
find_core() {
  local p d
  p="$(command -v sing-box 2>/dev/null || true)"
  if [[ -n "$p" ]]; then printf '%s' "$p"; return 0; fi
  for d in "$CORE_INSTALL_DIR" /usr/local/bin /usr/bin /bin /usr/local/sbin /opt/sing-box \
           "$HOME/.local/bin" "$HOME/go/bin" "$HOME/bin"; do
    if [[ -x "$d/sing-box" ]]; then printf '%s' "$d/sing-box"; return 0; fi
  done
  return 1
}

core_version() {
  "$1" version 2>/dev/null | sed -n 's/^sing-box version \([0-9][0-9.]*\).*/\1/p' | head -n1 || true
}

version_ok() {   # $1 = "1.14.2"
  local maj min
  IFS=. read -r maj min _ <<< "$1"
  maj="${maj:-0}"; min="${min:-0}"
  (( maj > MIN_MAJOR || (maj == MIN_MAJOR && min >= MIN_MINOR) ))
}

metadata_value() {
  sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" "${SCRIPT_DIR}/metadata.json" | head -n1
}

supported_shells() {
  sed -n '/"shell-version"/,/\]/p' "${SCRIPT_DIR}/metadata.json" | grep -o '"[0-9][0-9]*"' | tr -d '"' | tr '\n' ' '
}

confirm() {   # $1 = question; default answer: no
  if [[ $ASSUME_YES -eq 1 ]]; then return 0; fi
  if [[ ! -t 0 || ! -t 1 ]]; then return 1; fi
  local reply
  printf '\n  %s%s%s [y/N] ' "$B" "$1" "$Z"
  read -r reply || return 1
  [[ "$reply" == [yY] || "$reply" == [yY][eE][sS] ]]
}

# ------------------------------------------------------------------ banner
banner() {
  local ver
  ver="$(metadata_value version-name || true)"
  printf '\n%s%s Qurp %s%s %s— installer%s\n' "$B" "$C" "${ver:-}" "$Z" "$D" "$Z"
  rule
}

# ------------------------------------------------------------------ uninstall
if [[ $UNINSTALL -eq 1 ]]; then
  banner
  printf '%sRemoving Qurp%s\n\n' "$B" "$Z"
  gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
  rm -rf "${DEST}" && ok "extension removed (${DEST})"
  if [[ -d "${CORE_DIR}" ]]; then
    rm -rf "${CORE_DIR}"
    rmdir "$(dirname "${CORE_DIR}")" 2>/dev/null || true
    ok "private sing-box copy removed"
  fi
  if [[ -e "$HELPER_DEST" || -e "$POLICY_DEST" ]]; then
    note "removing the helper needs sudo"
    run_root rm -f "$HELPER_DEST" "$POLICY_DEST" && ok "kill switch helper and polkit policy removed"
  fi
  if command -v nft >/dev/null 2>&1; then
    run_root nft delete table inet qurp_ks >/dev/null 2>&1 || true
    ok "kill switch rules cleared"
  fi
  printf '\n  %sYour settings and logs in %s/qurp were kept; delete that folder to remove them.%s\n\n' \
    "$D" "${XDG_CONFIG_HOME:-${HOME}/.config}" "$Z"
  exit 0
fi

banner
if [[ $EUID -eq 0 && -n "${SUDO_USER:-}" ]]; then
  die "do not run the installer with sudo: it would install into root's home. Run ./install.sh as your normal user; it asks for sudo only where needed."
fi
if [[ $EUID -eq 0 ]]; then
  warn "running as root: the extension will be installed for root, not for your normal user"
fi

TOTAL=4
[[ $CHECK_ONLY -eq 1 ]] && TOTAL=1

# ------------------------------------------------------------------ 1. checks
step 1 "$TOTAL" "Checking your system"
SB=""; SB_VER=""; NEED_CORE=0; HARD_STOP=0

if command -v gnome-shell >/dev/null 2>&1; then
  GS_VER="$(gnome-shell --version 2>/dev/null | grep -o '[0-9][0-9.]*' | head -n1 || true)"
  GS_MAJOR="${GS_VER%%.*}"
  if [[ -n "$GS_MAJOR" && " $(supported_shells) " == *" ${GS_MAJOR} "* ]]; then
    ok "GNOME Shell ${GS_VER} (supported)"
  else
    warn "GNOME Shell ${GS_VER:-?} is not in Qurp's supported list ($(supported_shells)); it may not load"
    ATTN+=("GNOME Shell ${GS_VER:-?} is not officially supported; if the extension does not appear, that is why")
  fi
else
  warn "gnome-shell not found (an SSH session?): cannot check the shell version"
fi

if SB="$(find_core)"; then
  SB_VER="$(core_version "$SB")"
  if [[ -z "$SB_VER" ]]; then
    bad "sing-box found at ${SB} but it does not run"
    note "check: ls -l ${SB}   |   file ${SB}   |   SELinux: sudo ausearch -m avc -ts recent"
    NEED_CORE=1
  elif version_ok "$SB_VER"; then
    ok "sing-box ${SB_VER}  (${SB})"
  else
    bad "sing-box ${SB_VER} is too old (Qurp needs ${MIN_MAJOR}.${MIN_MINOR} or newer)  (${SB})"
    NEED_CORE=1
  fi
else
  bad "sing-box is NOT installed. Qurp cannot connect without it"
  NEED_CORE=1
fi

if command -v glib-compile-schemas >/dev/null 2>&1; then
  ok "glib-compile-schemas"
else
  bad "glib-compile-schemas is missing (needed to install the settings schema)"
  hint="$(pkg_cmd glib)"; [[ -n "$hint" ]] && cmd "$hint"
  HARD_STOP=1
fi

# optional parts: report them, warn only when the user asked for them
opt_check() {   # $1 tool, $2 logical package, $3 what it is for, $4 wanted (0/1)
  if command -v "$1" >/dev/null 2>&1; then
    ok "$1  ${D}(optional: $3)${Z}"
  elif [[ "$4" -eq 1 ]]; then
    warn "$1 not found: needed for $3"
    local h; h="$(pkg_cmd "$2")"; [[ -n "$h" ]] && cmd "$h"
    ATTN+=("$1 is missing, so $3 will not work until you install it${h:+ ($h)}")
  else
    note "$1 not found (only needed for $3)"
  fi
}
opt_check nft nftables "the kill switch" "$WITH_HELPER"
opt_check pkexec polkit "the kill switch" "$WITH_HELPER"
opt_check setcap libcap "TUN mode" "$WITH_TUN"

if [[ $HARD_STOP -eq 1 ]]; then
  die "fix the problem above and run ./install.sh again."
fi

# ------------------------------------------------------------------ sing-box download
install_core() {
  local arch tag ver url tmp bin
  command -v curl >/dev/null 2>&1 || { bad "curl is needed to download sing-box"; return 1; }
  command -v tar  >/dev/null 2>&1 || { bad "tar is needed to unpack sing-box"; return 1; }
  case "$(uname -m)" in
    x86_64|amd64)   arch=amd64 ;;
    aarch64|arm64)  arch=arm64 ;;
    armv7l|armv7)   arch=armv7 ;;
    i386|i686)      arch=386 ;;
    *) bad "no ready-made sing-box build for CPU '$(uname -m)': install it manually"; return 1 ;;
  esac
  note "asking GitHub for the latest sing-box release…"
  tag="$(curl -fsSIL -o /dev/null -w '%{url_effective}' https://github.com/SagerNet/sing-box/releases/latest || true)"
  ver="${tag##*/v}"
  [[ "$tag" == */releases/tag/v* && -n "$ver" ]] || { bad "could not find the latest sing-box version (no internet access to github.com?)"; return 1; }
  url="https://github.com/SagerNet/sing-box/releases/download/v${ver}/sing-box-${ver}-linux-${arch}.tar.gz"
  tmp="$(mktemp -d)"
  CORE_TMP="$tmp"
  note "downloading sing-box ${ver} (linux-${arch}) from github.com/SagerNet/sing-box"
  if [[ -t 1 ]]; then
    curl -fL --progress-bar -o "$tmp/sb.tgz" "$url" || { bad "download failed: $url"; return 1; }
  else
    curl -fsSL -o "$tmp/sb.tgz" "$url" || { bad "download failed: $url"; return 1; }
  fi
  tar -xzf "$tmp/sb.tgz" -C "$tmp" || { bad "could not unpack the download"; return 1; }
  bin="$(find "$tmp" -type f -name sing-box | head -n1)"
  [[ -n "$bin" ]] && "$bin" version >/dev/null 2>&1 || { bad "the downloaded sing-box does not run on this system"; return 1; }
  mkdir -p "$CORE_INSTALL_DIR" 2>/dev/null || true
  if [[ -d "$CORE_INSTALL_DIR" && -w "$CORE_INSTALL_DIR" ]]; then
    install -m 0755 "$bin" "${CORE_INSTALL_DIR}/sing-box"
  else
    note "installing into ${CORE_INSTALL_DIR} needs sudo"
    run_root install -D -m 0755 "$bin" "${CORE_INSTALL_DIR}/sing-box"
  fi
  if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled 2>/dev/null; then
    run_root restorecon -F "${CORE_INSTALL_DIR}/sing-box" >/dev/null 2>&1 || true
  fi
  ok "sing-box ${ver} installed to ${CORE_INSTALL_DIR}/sing-box"
  return 0
}

core_instructions() {
  bad "sing-box is required: Qurp does not bundle it"
  note "easiest: run this installer again with --install-core"
  cmd "./install.sh --install-core"
  note "or install it yourself (your distribution's package, or the official release):"
  note "https://sing-box.sagernet.org/installation/"
}

if [[ $CHECK_ONLY -eq 0 ]]; then
  if [[ $NEED_CORE -eq 1 ]]; then
    step 2 "$TOTAL" "Installing sing-box"
    if [[ $WITH_CORE -eq 1 ]] || confirm "Download and install the official sing-box release now?"; then
      if install_core; then
        SB="${CORE_INSTALL_DIR}/sing-box"; SB_VER="$(core_version "$SB")"
        if [[ -n "$SB_VER" ]] && version_ok "$SB_VER"; then
          NEED_CORE=0; DONE+=("sing-box ${SB_VER} ${D}->${Z} ${SB}")
          # an older sing-box earlier in PATH would still win
          FIRST="$(find_core || true)"
          if [[ -n "$FIRST" && "$FIRST" != "$SB" ]]; then
            FIRST_VER="$(core_version "$FIRST")"
            if [[ -z "$FIRST_VER" ]] || ! version_ok "$FIRST_VER"; then
              warn "an older sing-box (${FIRST_VER:-broken}) at ${FIRST} comes first in your PATH"
              ATTN+=("remove or update the old sing-box at ${FIRST}, otherwise Qurp will keep using it")
            fi
          fi
        fi
      fi
    else
      core_instructions
    fi
  else
    step 2 "$TOTAL" "sing-box"
    ok "already installed, nothing to do"
  fi

  # -------------------------------------------------------------- 3. extension
  step 3 "$TOTAL" "Installing the extension"
  for f in extension.js prefs.js metadata.json stylesheet.css; do
    [[ -f "${SCRIPT_DIR}/${f}" ]] || die "${f} is missing next to install.sh: run it from the Qurp folder."
  done
  for old in quick-proxy-client@gnome-shell-extension; do
    gnome-extensions disable "$old" >/dev/null 2>&1 || true
    rm -rf "${EXT_ROOT}/${old}"
  done
  # a clean directory, so files dropped in newer versions do not linger
  # (settings and logs live in ~/.config/qurp, not here)
  if [[ -n "${DEST}" && "${DEST}" == */extensions/${UUID} ]]; then
    rm -rf "${DEST}"
  fi
  mkdir -p "${DEST}/schemas" "${DEST}/locales"
  cp -f "${SCRIPT_DIR}/extension.js" "${SCRIPT_DIR}/prefs.js" "${SCRIPT_DIR}/metadata.json" \
        "${SCRIPT_DIR}/stylesheet.css" "${DEST}/"
  cp -f "${SCRIPT_DIR}/schemas/"*.xml "${DEST}/schemas/"
  cp -f "${SCRIPT_DIR}/locales/"*.json "${DEST}/locales/"
  ok "files copied to ${DEST}"
  glib-compile-schemas "${DEST}/schemas/"
  [[ -f "${DEST}/schemas/gschemas.compiled" ]] || die "compiling the settings schema failed"
  ok "settings schema compiled"
  DONE+=("extension ${D}->${Z} ${DEST}")

  ENABLED=0
  if command -v gnome-extensions >/dev/null 2>&1 && gnome-extensions enable "$UUID" >/dev/null 2>&1; then
    ENABLED=1
    ok "extension enabled"
  else
    note "not enabled yet: GNOME only sees a new extension after you log out and back in"
  fi

  # -------------------------------------------------------------- 4. optional parts
  step 4 "$TOTAL" "Optional parts"
  if [[ $WITH_HELPER -eq 0 && $WITH_TUN -eq 0 ]]; then
    note "kill switch:  ./install.sh --helper"
    note "TUN mode:     ./install.sh --tun"
    note "see all flags: ./install.sh --options"
  fi

  if [[ $WITH_HELPER -eq 1 ]]; then
    note "installing the kill switch helper needs sudo"
    run_root install -D -m 0755 -o root -g root "${SCRIPT_DIR}/helper/qurp-helper" "${HELPER_DEST}"
    run_root install -D -m 0644 -o root -g root "${SCRIPT_DIR}/helper/org.qurp.helper.policy" "${POLICY_DEST}"
    if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled 2>/dev/null; then
      run_root restorecon -F "${HELPER_DEST}" "${POLICY_DEST}" >/dev/null 2>&1 || true
    fi
    ok "kill switch helper installed (${HELPER_DEST})"
    DONE+=("kill switch helper ${D}->${Z} ${HELPER_DEST}")
    NEXT+=("switch the kill switch on in Qurp: Settings > Advanced")
  fi

  if [[ $WITH_TUN -eq 1 ]]; then
    if [[ -z "$SB" || -z "$SB_VER" ]]; then
      warn "TUN setup skipped: sing-box is not installed yet"
      ATTN+=("TUN mode was not set up because sing-box is missing: install it, then run ./install.sh --tun again")
    elif ! command -v setcap >/dev/null 2>&1; then
      warn "TUN setup skipped: setcap is missing"
    else
      REAL_SB="$(readlink -f "$SB")"
      # The capabilities go on a private copy that only you can execute. Putting them on the system
      # binary would let every local process (and user) run sing-box with cap_net_admin.
      note "giving a private copy of sing-box network capabilities needs sudo"
      mkdir -p "${CORE_DIR}"
      chmod 0700 "$(dirname "${CORE_DIR}")" "${CORE_DIR}"
      install -m 0700 "$REAL_SB" "${CORE_COPY}"
      run_root setcap cap_net_admin,cap_net_raw,cap_net_bind_service+ep "${CORE_COPY}"
      ok "TUN mode ready (private copy: ${CORE_COPY})"
      note "this copy does not follow package updates: run ./install.sh --tun again after updating sing-box"
      DONE+=("TUN: private sing-box copy ${D}->${Z} ${CORE_COPY}")
    fi
  fi
fi

# ------------------------------------------------------------------ summary
if [[ $NEED_CORE -eq 1 ]]; then
  ATTN=("sing-box is ${B}not installed${Z} (or too old): Qurp cannot connect until it is" "${ATTN[@]+"${ATTN[@]}"}")
fi

printf '\n'
rule
if [[ $CHECK_ONLY -eq 1 ]]; then
  if [[ ${#ATTN[@]} -eq 0 ]]; then
    printf '%s%s %sEverything needed is in place.%s Run ./install.sh to install.\n' "$G" "$S_OK" "$B" "$Z"
    printf '\n'; exit 0
  fi
  printf '%s%s %sSome things need attention:%s\n' "$Y" "$S_WARN" "$B" "$Z"
  for a in "${ATTN[@]}"; do printf '  %s•%s %s\n' "$Y" "$Z" "$a"; done
  printf '\n'; exit 2
fi

if [[ ${#ATTN[@]} -eq 0 ]]; then
  printf '%s%s %sQurp is installed.%s\n' "$G" "$S_OK" "$B" "$Z"
elif [[ $NEED_CORE -eq 1 ]]; then
  printf '%s%s %sQurp is installed, but it cannot work yet:%s\n' "$Y" "$S_WARN" "$B" "$Z"
else
  printf '%s%s %sQurp is installed, but some things need attention:%s\n' "$Y" "$S_WARN" "$B" "$Z"
fi
for d in "${DONE[@]+"${DONE[@]}"}"; do printf '  %s%s%s %s\n' "$G" "$S_OK" "$Z" "$d"; done

# next steps
if [[ $NEED_CORE -eq 1 ]]; then
  NEXT=("install sing-box:  ./install.sh --install-core   ${D}(or see the README, \"Installing sing-box\")${Z}" "${NEXT[@]+"${NEXT[@]}"}")
fi
if [[ "${XDG_SESSION_TYPE:-}" == "x11" ]]; then
  NEXT+=("restart GNOME Shell: press Alt+F2, type r, press Enter")
else
  NEXT+=("log out and log back in ${D}(GNOME loads new extensions at login)${Z}")
fi
if [[ ${ENABLED:-0} -eq 0 ]]; then
  NEXT+=("enable it:  gnome-extensions enable ${UUID}")
fi
NEXT+=("open the Qurp tile in Quick Settings > Settings > Subscriptions and add your link")
NEXT+=("if something fails, read the log:  ${XDG_CONFIG_HOME:-${HOME}/.config}/qurp/client.log")

printf '\n%sNext steps%s\n' "$B" "$Z"
i=1
for n in "${NEXT[@]}"; do printf '  %s%d.%s %s\n' "$B" "$i" "$Z" "$n"; i=$((i + 1)); done

# last thing on screen, so it cannot be missed
if [[ ${#ATTN[@]} -gt 0 ]]; then
  printf '\n%s%s %sACTION REQUIRED%s\n' "$R" "$S_WARN" "$B" "$Z"
  for a in "${ATTN[@]}"; do printf '  %s•%s %s\n' "$R" "$Z" "$a"; done
fi
printf '\n'
