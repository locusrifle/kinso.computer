# Offline password denylist

`common-passwords.txt` is an unmodified copy of CrackLib 2.10.3's
`share/cracklib/cracklib-small` (54,763 entries).

- Upstream: https://github.com/cracklib/cracklib/tree/v2.10.3
- Available offline source: `/nix/store/z22570nmsdggyhsvmpx1rkmy971bc3wn-cracklib-2.10.3/share/cracklib/cracklib-small`
- SHA-256: `a209692299ff87431db030aa9996c1e51e286f32ce567d78f600d5ae7068ec7f`
- CrackLib package licence: LGPL-2.1 (per the installed Nix package metadata);
  copy in `licenses/LGPL-2.1.txt`, third-party notice at the repo root.
  The licence text was copied offline from Electron's Chromium licence bundle;
  no CrackLib executable code is included.

This is a real password-checking dictionary, **not a ranked breach top-N list**.
It includes dictionary words as well as common passwords; exact single-word
matches are rejected, not arbitrary substrings or multi-word passphrases.
No thousands of combinatorial guesses were generated.
`common-passwords-extra.txt` supplements it with 48 hand-curated familiar long
numeric/keyboard/password sequences that are often absent from dictionaries.
These are not claimed to be a sourced or ranked dataset. A ranked breach list
should replace/supplement this offline list when fetching a vetted source is
allowed.

Checking uses NFKC and lowercase for the denylist/username only; passwords are
hashed exactly as entered (no whitespace stripping or normalisation).
