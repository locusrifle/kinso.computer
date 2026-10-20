# locker

The store for the imperfect repo: one loopback server with no dependencies,
behind the Cloudflare tunnel on the PC. The desktop's Shop offers US$40/month
rental and pay-what-you-want support for the free GitHub source, from US$1.
Legacy keyed members keep their repository access and updates.
Settings are listed at the top of `start.mjs`, operator
commands at the top of each `tools/*.mjs`. Secrets live in
`~/.imperfect/credentials/`, never here.

## Publish imperfect OS

OS licences (`product: os`) include app access. Legacy app-only (`code`) keys
cannot clone or download OS; no legacy upgrade is assumed. An operator can
issue one with `node locker/tools/license.mjs issue <email> --product os`.
Revocation stops new requests to both products, never the installed system.

`LOCKER_PRODUCT` also holds the read-only bare `imperfect-os.git`, immutable
ISOs in `os-downloads/`, and `os-release.json`. Publish with
`node locker/tools/publish-os.mjs --help` (operator-run; not automatic).
Publish only the clean public distro subset, never Noah's personal hosts or
private git history. Promote the manifest last, by atomic rename, after its
public commit and checksum-named ISO exist. Its schema is enforced in
`os-product.mjs`; an incomplete publication returns 503 rather than offering
a broken installer.

Buyers use their key as the Basic-auth password to clone
`https://imperfect.computer/imperfect-os.git`, read `/os-release.json`, then
fetch `/os/download/<installer.file>` and verify `installer.sha256`.
`/os/installer` downloads the current ISO directly. Downloads/manifest also
accept `?key=`, but Basic auth avoids keys in URLs. Only the current manifest's
ISO is served; staged or superseded files are not exposed. Every OS request
rechecks entitlement and disables caching, including ranges and HEAD.

## Deliberately not here

- Checkout buyers remain separate from rented-computer identities; never link by email.
  New OS purchases may explicitly link to the currently signed-in account.
- No DRM. A repository behind a key is a convenience for buyers, not a lock;
  anyone who pays can copy what they have.
- No automatic updates, on computers or phones. Members take the changes
  they want.

## New offers (off until configured)

Seller: **Noah**, not GST registered. No tax collection or GST line. Bring your
own supported AI subscription; AI usage, hardware and backups are not included.
GET `/buy` and `/rent.html` redirect home; POST `/buy` is retired. Legacy
`/thanks` and code webhooks remain for in-flight purchases and existing keyed members.

Set these in the private `locker.env` (also documented atop `start.mjs`):

| setting | purpose |
| --- | --- |
| STRIPE_SECRET_KEY | server secret/restricted key; never sent to browsers |
| STRIPE_WEBHOOK_SECRET | signing secret for `/webhooks/stripe` |
| STRIPE_RENT_PRICE | US$40/month recurring price |
| STRIPE_OS_PRICE | AUD 400 one-time lifetime price |
| RENT_GRACE_DAYS | integer 1–365, default 7 days unpaid before stop intent |
| RENT_RETENTION_DAYS | integer 1–365, default 30 days **after stop** |

Rental and OS offers need the key, webhook secret and their own price. Missing
any leaves those checkouts closed; testers still work without Stripe.
Source support uses custom USD amounts (US$1–10000) and needs only the Stripe key;
it grants no private entitlement. Its install command points to the free public repo. `/host.html` becomes a no-JS form to `/os/buy`. OS buyers need
no account; a signed-in purchase is linked explicitly using the account UUID,
not the checkout email. `/os/thanks` shows its product-tagged key and leads to
`/os/install`. The bootable installer download is **not published here yet**;
that guide states requirements and asks buyers to confirm hardware/install
steps with Noah before replacing disks. Both the thank-you path and webhooks
issue the same key; a persistent email outbox avoids losing purchase mail when
the browser arrives first. A crash between sending and acknowledging an email
can still send a duplicate email, never a duplicate licence.

Renters choose a username and password, save their recovery codes, then confirm **US$40/month**
from `/account`. Rental and portal POSTs require the canonical Origin and
session CSRF token. Checkout binds account + checkout attempt to the subscription.
Concurrent starts share a persisted reservation and Stripe idempotency key;
reservation replacement and operator grants are SQLite transactions.
Open checkout is reused; completed checkout waits for webhook confirmation.
Expired-checkout webhooks release pending reservations, permitting tester grants
or a fresh paid checkout. A lost checkout response older than 24 hours requires operator investigation,
not a blind second subscription. One non-canceled rental per account; cancel
in Stripe before granting a tester. Portal permits payment-method updates and
cancellation. A cancellation scheduled for period end keeps service active
until Stripe actually cancels it.

Verified, replay-idempotent webhooks re-read the **current** subscription (with
latest invoice expanded), rather than trusting out-of-order event snapshots.
Verified handlers are serialized; completion is recorded only after durable effects.
Mail drains in the background, never holding the billing queue. Failed or
unconfigured deliveries remain queued for the next webhook/thank-you request;
resend a Stripe event after fixing mail if there is no new traffic. Cancellation
is terminal for that checkout attempt; recoverable unpaid/paused subscriptions
retain their reservation and can recover without a second rental. A failed first
payment stays pending and never provisions service.
Events belonging to an older attempt cannot alter a replacement rental.
`active`, `past_due`, `canceled` and checkout `pending` are stored with period,
unpaid/stop/retention dates. Failed payments send an email with deadlines;
recovery and cancellation send status emails. Dates are computed from current
config during polling, so policy changes apply to existing unpaid rentals.
No scheduler or VM deletion lives in billing; **no data is automatically deleted**.
An operator must handle stop/retention reminders, support and explicit deletion.

### Testers and provisioning intent

```sh
node locker/tools/accounts.mjs grant alder --tester
node locker/tools/accounts.mjs grant alder --tester --until 2026-11-11
node locker/tools/accounts.mjs revoke alder
node locker/tools/accounts.mjs list
```

Grant only a claimed account; no card or Stripe request. `--until` expires at
00:00 UTC on that date. Revoke records cancellation and stop intent; it does
not delete the computer. The account page says the tester computer is being
made until its registered state is ready. Grants do not enforce the six-person
quota; Noah decides who receives one.

Provisioner polls authenticated `GET /api/accounts/rentals?want=provision|stop`
(without `want`, all rentals). Response: `{rentals:[...]}`, with accountId,
username, source, status, want, periodEnd, stopAt, deleteAfter, origin and
registered computer (or null). `provision` means service should exist/be running;
`stop` means it should not run (pending checkouts also have stop intent, so do
nothing if no computer exists). Past-due service stays wanted through the grace
window. Tester expiry is computed on each poll. The endpoint requires the
existing operator bearer token, but not the signing key; registration/SSO still
needs that key. Polling is read-only and never executes cloud actions. State
feedback uses existing `POST /api/accounts/computers`.

### Stripe setup

Create two new products: **imperfect rented computer**, US$40.00 every month;
**imperfect OS**, AUD 400.00 one-time lifetime. Do not replace the legacy price.
Disable automatic tax/Managed Payments; seller is Noah, no GST collected. Do
not enable public trials yet (testers use operator grants). Promotion codes are
accepted for Noah's eventual first-month code; its exact discount is his choice.

Webhook URL: `https://imperfect.computer/webhooks/stripe` (or first STORE_HOSTS
origin). Enable `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `checkout.session.expired`,
`customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
Stripe client pins API `2026-08-26.dahlia`; ensure endpoint payload compatibility.
The restricted key needs Checkout Sessions read/write, Subscriptions read,
Billing Portal Sessions write, and Customers/Invoices read for expanded objects
(not only the legacy checkout-write scope).
Enable the Customer Portal default configuration: payment-method updates,
billing history, cancel subscription (prefer at period end); restrict price
switching so people cannot buy a different plan. Configure retry/dunning with
Noah's grace policy and sender emails. Stripe dashboard cancellation/refund
remains operator-controlled; OS refunds do not automatically revoke licences.

Before enabling prices, Noah must approve lifetime-update terms, installer
availability, hardware support, rental retention/grace/cancellation terms and
public launch messaging. Merely setting prices enables checkout: do so only
when those promises are ready.

## Outside this tree

**Stripe.** One product, *the imperfect repo*, tax code `txcd_10202001`
(downloadable software, non-recreational), with a one-time price of $150 USD,
tax-inclusive, so every buyer pays $150 whatever their tax. The store sells
as Locus (Managed Payments off) and collects no tax until Stripe Tax is
registered and `automatic_tax` is turned on. The key is a restricted one
(`rk_live_…`) with Checkout Sessions write and nothing else. The webhook is
`https://<first store host>/webhooks/stripe`, sending
`checkout.session.completed` and `checkout.session.async_payment_succeeded`.

**Cloudflare.** Each store hostname is a public hostname on the
`imperfect-website` tunnel, pointing at `http://127.0.0.1:4322`; the demo is
`demo.imperfect.computer`, pointing at `http://127.0.0.1:4323`. To move the
store, add the hostname to the tunnel and DNS, then put it first in
`STORE_HOSTS`.

## Accounts (rented computers)

People sign up at `https://imperfect.computer/account/signup` with a username,
display name and password; sign in at `/account` with username and password.
Usernames are immutable, unique, 3–20 lowercase ASCII letters/digits/hyphens,
starting and ending with a letter or digit (DNS-safe). Infrastructure/brand names
are reserved, including www, store, demo, mail, admin, api, noah, locus and vaita;
the full list is `RESERVED_USERNAMES` in `store.mjs`. Accounts are UUIDs. Optional
email is stored unverified for receipts/future recovery, never for sign-in or
identity linking. No external sign-in application or working email is needed.

Passwords are 10–256 characters; passphrases are welcome. Common passwords and
passwords containing the username are refused; no composition rules. Versioned,
salted scrypt hashes are upgraded on login. Failed sign-ins are generic, with
bounded per-address, global and per-username throttles that clear after a minute.
Account budgets use socket addresses and ignore caller-supplied forwarding/CF
headers. A loopback ingress therefore shares a conservative address bucket;
trusted ingress-specific client attribution can be added explicitly later.
Sign-out remains available even when credential-work budgets are exhausted.
New anonymous form bindings have a separate allocation budget; recognized
browser bindings can still be reused. Verification uses the same scrypt work
schedule for current, historical and nonexistent accounts to avoid cheaper
legacy/unknown failure paths. The offline denylist is a reproducible 54,763-entry
CrackLib dictionary plus 48 hand-curated common values, not a ranked breach list;
see `common-passwords.README.md` for provenance and the remaining coverage caveat.

Sign-up displays eight single-use recovery codes once, then asks **I saved these**.
Save them somewhere outside this computer. `/account/recover` accepts username,
one code and a new password, consumes the code atomically and signs out all
store sessions and desktop devices (it does not automatically sign you in).
The account page allows password changes with the current password, recovery-code
regeneration with password confirmation, sign-out and sign-out everywhere.
Password changes rotate the current session while keeping this browser signed
in, and revoke the others and desktop credentials. Regeneration replaces all old
codes and pending operator links; plaintext codes are never stored or available
to redisplay. Sign out everywhere also invalidates pending operator links. Email recovery can be added later using the
existing email-verification and reset-token records, but no mail recovery exists
now.

For a tester who has lost access, operator-run commands:

```sh
node locker/tools/accounts.mjs reset-password alder
node locker/tools/accounts.mjs regenerate-codes alder
```

Each prints a one-time `/account/reset?token=...` link valid for 24 hours. Hand it
to the tester privately; it is a credential, not something to log or put in notes.
Only its hash is stored. Password reset consumes the link and revokes store
sessions and desktop credentials; codes reset displays eight new codes once.
Neither resets an independent computer door session.

Set file paths in `credentials/locker.env` using the settings at the top of
`start.mjs`. Exact defaults, all under `~/.imperfect/credentials/`:

| setting | default filename |
| --- | --- |
| ACCOUNTS_SIGNING_KEY_FILE | accounts-signing-key.pem |
| ACCOUNTS_OPERATOR_TOKEN_FILE | accounts-operator-token |

Each file contains only that value, with optional trailing newline; regular
files, mode 0600 (credentials directory 0700). Account files must resolve inside
`~/.imperfect/credentials/`, not the repo or locker state, even when
`IMPERFECT_PREFIX` is changed. No credentials are accepted inline or fetched
from other computers. Password sign-up/sign-in works without these files.
No signer means SSO/provisioning unavailable. No operator token means no provisioning API access. The canonical
origin is `ACCOUNTS_BASE=https://imperfect.computer`, not the first checkout
host; its host must also be in `STORE_HOSTS`.

Provision keys locally, never in the state directory, repository or a Nix
store. Run this only once; never overwrite an existing signing key or operator
credential. For example, **operator-run setup** (not done by this change):

```sh
umask 077
mkdir -p ~/.imperfect/credentials
openssl genpkey -algorithm ED25519 -out ~/.imperfect/credentials/accounts-signing-key.pem
openssl rand -base64 32 > ~/.imperfect/credentials/accounts-operator-token
```

Keep the signing key stable and backed up securely: rotating it requires
reprovisioning the public key on every computer. Only its Ed25519 SPKI public
PEM leaves the PC. Existing checkout remains independent and unchanged.

Provisioning API: bearer credential from accounts-operator-token;
`POST /api/accounts/computers` JSON `{username,computerId,state}` registers or
updates the state (provisioning/ready/stopped/failed). The username must already
be claimed. One immutable computer id and owner per username; no transfers.
`GET /api/accounts/computers/<username>` returns the same
`{computerId,username,state,origin,owner,store,publicKey}`. Origin is always
`https://<username>.imperfect.computer`; there is no caller-supplied callback.
Provision the returned owner/id/store/public key using the door's SSO settings.
Only ready computers receive assertions.

The door starts at `/account/computer?computer=<id>&nonce=<32-byte-base64url>`.
After sign-in/recovery-code confirmation, the store offers Continue, posting a 60-second Ed25519
JWT to that registry computer's `/door/callback`. The door owns challenge and
assertion replay protection, and its own persistent 30-day sessions; an outage
of the PC doesn't end them. Store sessions likewise last 30 days, are stored
only as token hashes in SQLite, and use host-only HttpOnly Secure SameSite=Lax
`__Host-imperfect_account` cookies. Mutations require exact canonical Origin
and per-session CSRF. Anonymous forms use a browser-bound, server-tracked
15-minute `__Host-imperfect_form` cookie and CSRF token; login rotates the account
session, preventing fixation. Account pages use strict-origin referrers: form
POST Origin remains verifiable, while recovery codes, reset tokens, challenge
parameters and assertions never enter the referrer.
Request failures are generic and account routes never log codes or tokens.
Signing out here ends this store session and revokes all the account's desktop
devices (including outstanding desktop codes). `/door/logout` ends a computer
session; already-issued independent door sessions keep their existing lifetime.
Sign out everywhere revokes every store session and desktop credential; door
sessions remain independent.

The desktop app opens account sign-in in the browser, then asks explicitly to
authorize a labelled device for the ready computer owned by that account. Just
opening the link never grants access. Hardware permissions remain off until the
person enables them in the app. The account page lists desktop devices, when
they were added and last used, and lets the person revoke each one.

Desktop access lasts at most five minutes. Refresh rotates on every use, with
a fixed 30-day maximum per device; reuse of any old refresh token revokes the
whole device, including every access token it issued. Credentials are stored
only as hashes. They cannot open store browser routes, and a computer must
check its own immutable owner/id binding with the store before accepting them.
The app obtains an independent door session from its computer, not a store
cookie. A store outage prevents new desktop authorization/refresh and live
hardware access checks; it does not end existing browser door sessions.

Fixtures can inject config/clock into createAccounts; explicit
allowInsecureTest permits HTTP fixture cookies. Production start does not set
it. start.mjs sets umask 0077 and tightens the state directory and database
permissions; keep locker.db and its WAL private.
