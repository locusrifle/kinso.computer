# Desktop account boundary

Production broker is `https://imperfect.computer`; there is no arbitrary-host setting. Sign-in opens the system browser, never an embedded password page:

`GET /account/desktop/authorize?redirect_uri=http://127.0.0.1:<ephemeral>/callback&state=<random>&code_challenge=<S256>&code_challenge_method=S256&device_name=<label>`

The broker preserves the flow through username/password sign-in or sign-up and recovery-code confirmation, verifies a ready owned computer, and asks explicit consent. GET never issues a grant; consent POST requires the account session, exact Origin and CSRF. The redirect carries only a <=60s single-use code and the unchanged state. Loopback URI is exactly IPv4 `127.0.0.1`, ephemeral port, `/callback`, no credentials/query/fragment. Code binds the URI, PKCE challenge and account.

Native `POST /account/desktop/token` JSON accepts `{grant_type:'authorization_code',code,redirect_uri,code_verifier}` or `{grant_type:'refresh_token',refresh_token}` and returns:

```
{ username, computerOrigin, accessToken, refreshToken, expiresAt, deviceId }
```

Expiry is epoch milliseconds; deviceId is a broker-minted UUID stable for the refresh family. Access lasts five minutes, refresh at most 30 days absolute; refresh rotates, and reuse revokes the entire family and its access tokens. Username follows launch rules; origin must be exactly `https://<username>.imperfect.computer`. Native validates this binding BEFORE any computer request.

Before attachment, each fresh/rotated grant completes:

1. Computer `POST /door/desktop/challenge` JSON `{}` → `{nonce}` (43-character random challenge, <=60s, single-use).
2. Broker `POST /account/desktop/door`, bearer access token, JSON `{nonce}` → `{assertion}`. Existing Ed25519 assertion includes `purpose:'desktop'`, `device:deviceId` and the owner/computer/nonce binding.
3. Computer `POST /door/desktop/session` JSON `{assertion}` → `{doorCookie:{name:'__Host-imperfect_door',value,expiresAt}}`.

No store browser cookie or fake broker-issued door session. Native validates the actual independent host-only door cookie and installs it Secure/HttpOnly/Path=/ only for the validated origin. Every native HTTP request refuses redirects, omits cookies/Origin, bounds response size and duration, and supports cancellation. Broker native routes reject any browser Origin and expose no CORS. Browser challenges/assertions remain separate.

The computer authenticates `/device-hands` independently using bearer introspection (`/account/desktop/introspect`, bound computer/owner/device). Native registers the grant's deviceId, not a local random replacement. Expiry, revocation or broker outage disconnects hands. No shared-token fallback for account-enabled computers. All hands permissions begin off, remain native-only, and are never persisted.

Sign-out first disconnects hands and aborts pending login/refresh, then sends bounded broker `POST /account/desktop/revoke` JSON `{refresh_token}` before forgetting. Revoke recognizes historical rotated tokens as family references. Late grants are revoked rather than attached. Local encrypted grant and BOTH cookie profiles are always cleared, even when revoke fails; the app explicitly warns when server revocation is not confirmed and directs the person to revoke the device on their account page when online. The store account page lists/revokes devices; account browser logout revokes its desktop families. Existing independent door sessions retain their own expiry/logout semantics; deleting a device revokes native credentials, not unrelated browser sessions.

Native saves grants only with Electron safeStorage backed by a real OS key store (never Linux basic_text). An unexpired remembered grant and cookie can open the page without refreshing; hands still requires live introspection. If access or cookie expires and refresh fails, hands are off and sign-in is required. Logs contain no credentials, codes, assertions, output, file contents or screenshots.

Tests explicitly inject canonical HTTP IPv4-loopback `{broker,testOrigin}` into auth functions. Complete-cookie legacy fixtures are accepted only with this injection; all grants still require deviceId. No production CLI/environment override exists. Packaged-like E2E uses a disposable staged main-process transport adapter; auth, sandbox and native UI controls stay unchanged.
