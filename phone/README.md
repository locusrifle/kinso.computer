# the Android app

A window into the person's computers: not an agent host, a database, or a
remote desktop.

- Sessions, files, credentials and agents stay on the computers. Closing or
  uninstalling the app removes none of them and stops no agent.
- It reaches them only over private Tailscale HTTPS: no account, nothing
  public.
- The app carries no machine addresses, so one build serves everybody;
  scanning the QR code `./install.sh phone` shows pairs it.
- Other computers are reached through the paired one. A session never moves,
  and work is never quietly sent anywhere but where it was asked.
- Websites and sign-in links open in the phone's own browser; the app keeps
  no cookie jar of its own.
- The browser agents drive on a computer comes up in a panel of its own,
  live: a picture of the tab in front, only while the panel is in sight, used
  from the phone with taps, typing and scrolling. Pages and games agents make
  still play on the phone itself.
- The app shows the page its computer serves, so that changes with the
  computer. The app itself changes only when the person installs a new one.

## Build

JDK 17+ and Android SDK platform 36. `local.properties` names only the SDK
(`sdk.dir=/home/you/Android/Sdk`).

```sh
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
IMPERFECT_ANDROID_SIGNING=~/.imperfect/credentials/android-release.properties \
  ./gradlew assembleRelease    # what ships
```

What ships is the release build, signed with the imperfect key on the PC; a
debug build cannot update an installed release app. Never move the key, or
uninstall the app, to get around a signature mismatch. Pin it for members
with `node locker/tools/pin.mjs --apk <apk>`.

`node --test phone/tests/*.test.mjs` checks source only; it runs no Android.
Install on a real phone, or change its wireless debugging, only with the
person's say-so.
