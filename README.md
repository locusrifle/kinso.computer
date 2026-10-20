# Kinso's computer

imperfect, in Kinso's name: one intelligence that is yours, on every screen
you use. Its interface is a web page, so it fits any screen and travels
anywhere. Pick your harness (Claude Code, Codex or Pi), then your model, and
ask: what it makes opens right beside the conversation and lives in your
Workbench, with your files and projects. It runs on Linux and macOS, with a
desktop app and an Android app that reach the same computer.

A concept by Noah Fleming, made in imperfect: not a Kinso product. This is
[imperfect](https://github.com/locusrifle/imperfect) with its window wearing
Kinso's name (one word: `apps/code/native/public/js/brand-default.js`).
Kinso's own logo and typefaces are theirs and are not in this repository;
the window shows Kinso's name in their place.

Website: [kinso.computer](https://kinso.computer)

## Get it

One command, for your user (no root), on Linux or macOS:

    curl -fsSL https://kinso.computer/install | sh

Or clone it yourself, then ask your agent to read `AGENTS.md`: it installs,
updates (only the changes you pick), and undoes everything from there.

    git clone https://github.com/locusrifle/kinso.computer ~/imperfect
    cd ~/imperfect
    ./install.sh          install, or bring the install up to this checkout
    ./install.sh update   see what is new
    ./install.sh phone    put the Android app on a phone
    ./install.sh undo     put the computer back the way it was

Bring your own Claude or ChatGPT subscription and sign in inside it.

## Licence

Copyright © 2026 Locus. **[MIT](LICENSE)**. Files
by other authors keep their own terms, listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
