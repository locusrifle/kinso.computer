# Rented computers (operator on the PC)

This is not a deployment script for Noah's existing computer. It creates a new
OVH Public Cloud computer in Sydney from a previously uploaded imperfect OS
image. No Stripe/card is involved. Renters bring their own model subscriptions.

## Credentials Noah creates

Keep every credential below **only on the PC** in `~/.imperfect/credentials/`.
Use a private directory (0700), files 0600, no shell tracing, no credentials in
arguments, screenshots, Git, notes or reports. The command never prints keys,
passwords, user-data or provider response bodies. Config-drive/user-data contains
secrets: anyone with sufficient project-level cloud access can read them.

### OVH: runtime user, compute only

1. OVHcloud Manager → Public Cloud → project **imperfect** → Settings →
   **Users & Roles** → **Create User**. Description `imperfect-provision`.
2. Select **Compute Operator**, not Administrator. This permits Nova compute
   management and image/network/security-group reads; no Swift, image-write,
   billing or unrelated project rights. It is project-wide, not per-instance:
   use a separate project for stronger isolation. Do not add Network Operator
   just to boot on the existing public network. A cloud-side security group
   allowing TCP 22/80/443 must already exist; this tool does not change it.
3. Save the generated username and password directly in
   `~/.imperfect/credentials/ovh-openstack.json` (0600). Download that user's
   SYD1 OpenStack RC file if needed to find the project ID/domain fields; keep
   the RC in the credentials directory, never source it in a traced shell.
   See the JSON example below. The endpoint is `https://auth.cloud.ovh.net/v3`.

OVH officially documents password-scoped OpenStack users. Keystone application
credentials are also supported by this tool if available for the project; do
not assume OVH offers them until verified. No OVH main-account/API key is needed.

### Cloudflare: only this zone's DNS

Cloudflare → profile → API Tokens → Create Custom Token:
**Zone / DNS / Edit**, zone resource **Include / Specific zone /
imperfect.computer**. The explicit zone ID avoids zone discovery, so no account
administration, tunnels, workers or other zones are required. An IP restriction
to the PC's stable egress IP and expiry are useful when practical.

Save the token directly as `cloudflare-api-token` (0600). A `cloudflare-token`
fallback is supported; `"cloudflareTokenFile"` in `provision.json` names the
file to use and nothing else (prefer a token limited to this zone). Both filenames existed when this task began; only their
names were checked, not their values or permissions/scopes. Verify scopes before
reuse. Records are A records with `proxied: false` (DNS-only).

### Store/accounts and support

- `accounts-signing-key.pem`: the locker's Ed25519 signing key, 0600. Rental
  computers take their SSO public key from it (`signerPublicKey`), so the locker
  must be able to read it on the same PC.
- `accounts-operator-token`: the accounts worker's operator bearer credential,
  0600. It authorizes the HTTP accounts registry for operators elsewhere. Rental
  sync does not need it: it reads and writes the registry in the locker's own
  database. Without it, a manual provision still gets SSO only from the registry.
- `accounts-public-key.pem`: the **public** Ed25519 SPKI verification key
  exported by accounts (never its private signing key). Store in the credential
  directory for the pre-accounts fallback.
- `ovh-cloud-ssh.pub`: Noah's support **public** SSH key. Only this public key
  goes onto the computer (root). Its private partner stays on the PC. Do not
  regenerate/replace Noah's key merely to provision.
- `provision.json`: deployment settings and renter→email/owner mapping, 0600.
  This mapping is operator-supplied; email is **not** used to link accounts.

For the accounts setup, create the operator token only if the file does not
already exist: `(umask 077; set -C; openssl rand -hex 32 >
~/.imperfect/credentials/accounts-operator-token)`. Shell noclobber refuses an
existing file. Configure the accounts service to read that same file; do **not**
rotate an existing token merely to provision. Once accounts has created its signing key, export only its
public half (do not rotate/recreate an existing signer):

```sh
umask 077
openssl pkey -in ~/.imperfect/credentials/accounts-signing-key.pem -pubout \
  -out ~/.imperfect/credentials/accounts-public-key.pem
```

Signer creation belongs to the accounts setup, not this tool. Username/password
sign-up needs no external application or email setup. The provisioner needs no
private signing key or renter password.

The issued computer member key and random bootstrap password are retained at
`credentials/provision/<username>.json` (0600), never displayed by the tool.
Transfer the password privately only if using PAM. It works once, not as an
enduring Unix/sudo password. Browser sessions persist; another device needs SSO
or a new support-issued bootstrap password. Configured SSO never uses PAM; the
password remains in the bootstrap only for payload compatibility. Verify the
accounts service and the selected image's SSO support before promising sign-in.

## Upload once (parent/Noah only)

Create a **separate** OVH Users & Roles user `imperfect-image-upload`, with
**Image Operator only**. Revoke/delete this user after upload if not maintaining
images. It can create/read/import images but cannot manage computers.

Save this cloud configuration as
`~/.imperfect/credentials/ovh-upload.yaml` (0600); replace the placeholders
privately. The domain fields must match that user's downloaded OpenStack RC:

```yaml
clouds:
  imperfect-upload:
    auth_type: v3password
    region_name: SYD1
    interface: public
    identity_api_version: 3
    auth:
      auth_url: https://auth.cloud.ovh.net/v3
      username: '<generated upload username>'
      password: '<generated upload password>'
      project_id: '<imperfect project id>'
      user_domain_name: Default
      project_domain_name: Default
```

Build the image in the OS checkout using the documented rootless Nix launcher
(or ordinary Nix after installing); never build with credentials as flake inputs.
Use the image's exact qcow2 artifact path. With `python-openstackclient` installed:

```sh
IMAGE_NAME="imperfect-renter-$(git -C /path/to/imperfect-os rev-parse --short HEAD)"
OS_CLIENT_CONFIG_FILE="$HOME/.imperfect/credentials/ovh-upload.yaml" \
  openstack --os-cloud imperfect-upload --os-region-name SYD1 image create \
    "$IMAGE_NAME" --private --disk-format qcow2 \
    --container-format bare --property hw_firmware_type=uefi \
    --property hw_disk_bus=scsi --property hw_scsi_model=virtio-scsi \
    --property hw_vif_model=virtio --property os_type=linux \
    --property os_distro=nixos --min-ram 4096 \
    --file /absolute/path/to/imperfect-renter.qcow2
```

Run `openstack ... image show <image-id> -c status -c id` with the same cloud
configuration and wait for `active`. Put the image ID into `provision.json`.
Images and instances are region-specific: upload to SYD1, not another region.
Never upload a snapshot of a booted renter or Noah's computer: it contains
identity, data and credentials. Upload only the clean build artifact.

Stopping an instance does **not** eliminate OVH's storage/instance billing.
Retention is not a backup, and there are no tester backups. A later explicit
operator delete, after 30 days stopped, removes the machine permanently.

Public references: [OVH OpenStack users](https://help.ovhcloud.com/csm/en-public-cloud-compute-openstack-users?id=kb_article_view&sysparm_article=KB0050591),
[OVH role rights](https://github.com/ovh/ovhcloud-docs/blob/develop/docs/en/guides/manage-and-operate/iam/authenticate-api-openstack-with-service-account.mdx).

## Configuration and commands

Create the directory/files privately (for example with an editor), not with
secret-bearing command arguments:

```sh
umask 077
mkdir -p ~/.imperfect/credentials
chmod 700 ~/.imperfect/credentials
# Edit the following JSON files here, then chmod 600 each one.
```

`ovh-openstack.json` (runtime Compute Operator user):

```json
{
  "authUrl": "https://auth.cloud.ovh.net/v3",
  "username": "<generated runtime username>",
  "password": "<generated runtime password>",
  "projectId": "<imperfect project id>",
  "userDomainName": "Default",
  "projectDomainName": "Default"
}
```

`provision.json`:

```json
{
  "imageId": "<active SYD1 image UUID>",
  "networkId": "<SYD1 public Ext-Net UUID>",
  "zoneId": "<Cloudflare imperfect.computer zone id>",
  "storeUrl": "https://imperfect.computer",
  "serviceHosts": [
    "compute.syd1.cloud.ovh.net",
    "image.compute.syd1.cloud.ovh.net"
  ],
  "storePublicKeyFile": "accounts-public-key.pem",
  "securityGroupNames": ["default"],
  "renters": {
    "alice": {
      "email": "<renter's store email>",
      "ownerAccountId": "<accounts owner id>"
    }
  }
}
```

`flavor` is the instance size, `d2-4` (2 vCPU, 4 GB) unless set; a renter's
own `renters.<username>.flavor` overrides it (for example `d2-8`). The image's
`--min-ram 4096` lets it boot on d2-4 and larger.

`securityGroupNames` selects existing Nova security groups (default `default`).
Verify that those groups permit inbound TCP 22/80/443. If they do not, the parent
must create/review a suitable group separately using a Network Security Operator
credential and then select it here; the runtime tool cannot create firewall rules.

Find the network UUID in Horizon → Project → Network → Networks → the public
`Ext-Net`; don't create a new private network. Find the Cloudflare zone ID on
that zone's Overview page. The service hostname allowlist must match the SYD1
public Compute/Image endpoints in that user's OpenStack catalog. Do not widen
it to arbitrary hosts to work around a failure. Defaults above are examples:
verify against the catalog for this project. Credentials never follow redirects.

Accounts registry owner/public key take precedence if the operator token is
present; any explicit owner mapping must agree. Email comes from a store buyer
with the matching handle or the explicit mapping above. An account's optional,
unverified email is not an identity-linking mechanism. `storeUrl` is a plain HTTPS origin,
with no credentials, path, nonstandard port, query or fragment.

A **new bootstrap** with an authenticated, validated accounts computer record
includes `sso = {storeUrl, computerId, ownerAccountId, storePublicKey}`, taken
exactly from that record's `store`, `computerId`, `owner` and public key. This
explicitly enables the image's SSO launch path. Without an operator token,
`sso` is omitted and one-use PAM remains available; top-level license fields
do not enable SSO. A refused or invalid registry response never falls back to PAM.

Saved bootstraps accept only the original field set or that set plus the complete
four-field `sso` object. Saved SSO must match the current authenticated registry;
partial/extra/mismatched fields or an absent operator token are refused. Reruns
never rewrite a saved payload or silently add SSO to a legacy PAM bootstrap,
even if registration becomes available before VM creation. After a creation
attempt or with an existing VM, replacing bootstrap secrets is also refused.
The OS does not reread metadata after first provisioning: moving an existing
PAM computer to SSO requires a separate trusted persisted/declarative OS change,
not a provisioning rerun or metadata edit.

The local store database must already exist at `~/.imperfect/locker/locker.db`.
A computer gets its own idempotently issued license (the same `issueLicense`
operation as `license.mjs`), not an existing personal license. Issuing it does
not charge money, send mail or modify Stripe.

```sh
cd /path/to/imperfect
node locker/tools/provision.mjs provision alice --dry-run
node locker/tools/provision.mjs provision alice
node locker/tools/provision.mjs list
node locker/tools/provision.mjs deprovision alice stop --dry-run
node locker/tools/provision.mjs deprovision alice stop
# After 30 full days confirmed stopped:
node locker/tools/provision.mjs deprovision alice delete --dry-run
node locker/tools/provision.mjs deprovision alice delete
```

Provisioning prints the ready URL, **never the bootstrap password/member key**.
It waits for an active instance, a DNS-only A record and a successful public
`/healthz` response over normally verified TLS, then sets the accounts registry
ready if configured. No `--insecure`, self-signed production certificate or
Cloudflare proxy workaround is used. Image/testing details are in the OS repo.

State is private at `~/.imperfect/provision/`; list reports this operator's
managed computers, not all resources in the OVH project. A single exclusive
`operator.lock` protects concurrent operations. After an operator crash, verify
no command is running before removing the stale lock. Keep the operator/state
files: their UUIDs and matching VM metadata/DNS comments prove ownership.

Rerun the same command after transient failures. A lost create response is
reconciled by ownership, never blindly repeated. If no owned VM/record becomes
visible, creation remains unresolved and stops: the parent must inspect the
provider inventory and retained create intent before manually repairing state.
Foreign/existing VM or DNS collisions are refused, never adopted or overwritten.
Creation defaults may rotate to a new image/network without preventing
retirement of older computers. The authenticated project, DNS zone and store
remain bound to saved state; changing them is refused. A retained VM observed
running again receives a new 30-day window when stopped again (including recovery
from a lost stop response). Confirmed DNS records may be recreated if lost;
ambiguous unconfirmed creations remain blocked.

Deleted names are not automatically reused. Stop removes DNS and marks accounts
stopped; deletion revokes only the computer-specific license and removes its
local bootstrap credential file. There is no background deletion timer: the
operator explicitly runs delete after retention.

## Rentals become computers (automatic)

`tools/rental-sync.mjs` runs the same provisioner for rentals, without a hand-written
`renters.<username>` entry. One pass reads `rentals.list('provision')` and
`rentals.list('stop')` from the store:

- An active rental with no ready computer is provisioned. The renter's username,
  email and owner come from the account (`accounts.email`, else the rental's Stripe
  email). Testers get `d2-8`; paid rentals keep `d2-4`. A manual `renters` entry
  still sets its own `flavor`.
- A rental that has ended stops its running computer (`deprovision … stop`). It
  never deletes, and a stopped (retained) computer is never reprovisioned.
- The registry is the locker's own, in-process (`localRegistry`). The account page
  shows "being set up", then "ready at https://<username>.imperfect.computer".
  The renter gets one "ready" mail (queued once, retried until sent).
- A renter with no email is skipped and named in the output. A failure is printed
  as a fixed message and retried on the next pass.

Run once, or as a long-lived user unit (the pass waits on provisioning, so it must
not be a child of an agent):

```sh
node locker/tools/rental-sync.mjs                 # one pass; prints a JSON summary
systemd-run --user --unit=imperfect-rental-sync --property=Restart=on-failure \
  --property=RestartSec=60 node /home/vaita/imperfect/locker/tools/rental-sync.mjs --loop 60
```

The unit is not started by the change that adds this file. Noah starts it after
the real OVH steps, the image upload and one manual `provision` of `tom` succeed.

