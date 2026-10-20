#!/bin/sh
# imperfect is free and open source. This installs it for your user, not root.
set -eu

say() { printf '%s\n' "imperfect: $*"; }
die() { say "$*" >&2; exit 1; }
# One command for Linux and macOS: ./install.sh then installs what fits this
# computer (systemd services on Linux, imperfect.app in the Dock on a Mac).
case "$(uname -s)" in
  Linux) os=Linux ;;
  Darwin) os=macOS
    # A Mac's git is a stub until Apple's command line tools are installed.
    xcode-select -p >/dev/null 2>&1 || die "Install Apple's command line tools first (run: xcode-select --install), then run this command again." ;;
  MINGW*|MSYS*|CYGWIN*) die 'imperfect installs on Linux and macOS. On Windows, run this command inside WSL (Ubuntu).' ;;
  *) die "imperfect installs on Linux and macOS; this computer runs $(uname -s)." ;;
esac
command -v git >/dev/null 2>&1 || die 'Install git, then run this command again.'
command -v bash >/dev/null 2>&1 || die 'Install bash, then run this command again.'
say "Installing imperfect for $os."
: "${HOME:?HOME must name your home directory}"
repo='https://github.com/locusrifle/imperfect'
dest="$HOME/imperfect"

if [ -e "$dest" ] || [ -L "$dest" ]; then
  [ ! -L "$dest" ] || die "$dest is a symbolic link; leaving it alone."
  [ -d "$dest/.git" ] || [ -f "$dest/.git" ] || die "$dest exists but is not a git checkout; leaving it alone."
  origin=$(git -C "$dest" remote get-url origin) || die 'This checkout has no origin; leaving it alone.'
  case "$origin" in
    "$repo"|"$repo.git"|git@github.com:locusrifle/imperfect.git|ssh://git@github.com/locusrifle/imperfect.git) ;;
    *) die "$dest is not the public imperfect repository; leaving it alone." ;;
  esac
  [ -z "$(git -C "$dest" status --porcelain)" ] || die 'Your checkout has changes. Commit or save them before updating.'
  [ "$(git -C "$dest" symbolic-ref --quiet --short HEAD)" = main ] || die 'Your checkout is not on main; leaving it alone.'
  say 'Checking for updates from GitHub (fast-forward only).'
  git -C "$dest" fetch --quiet origin refs/heads/main
  git -C "$dest" merge --ff-only FETCH_HEAD
else
  say "Cloning the free source code into $dest."
  git clone --branch main -- "$repo" "$dest"
fi
cd "$dest"
[ -x ./install.sh ] || die 'This checkout has no executable install.sh.'
say 'Running ./install.sh. It needs no root and leaves working agents alone.'
# Keep a piped installer from consuming the remainder of this downloaded script.
./install.sh </dev/null
