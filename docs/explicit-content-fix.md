# Explicit content policy

Updated 2026-11-27 after the 0.5.0 beta 2 release audit.

## Current behavior

Arlet does not change MusicKit's content policy. The Settings page no longer
offers Allow or the former consent dialog. Production startup, sign-in,
settings changes, and playback do not read MusicKit's private
`restrictedEnabled` property or its `music.<team>.itre` storage value, and do
not write either one.

- **Auto** leaves playback decisions to Apple Music. When MusicKit reports
  `CONTENT_RESTRICTED`, Arlet says MusicKit restricted the track; it does not
  claim to know which account control caused the result.
- **Clean** applies an Arlet-side queue filter. It keeps tracks Apple rates as
  clean and skips explicit or unverified tracks. Arlet does not replace the
  requested recording with a clean equivalent; the listener can choose a
  different recording directly.
- The filter does not alter the Apple Account's settings. It is stored as a
  local app preference.

Settings written by older versions may contain `explicitContent: "allow"` and
`explicitFix: true`. The native settings reader and writer normalize these to
Auto and false. The frontend accepts only Auto or Clean and omits the retired
opt-in field when it saves settings. The old helper remains in the source tree
for historical reference, but production modules must not import it.

## Why Allow was retired

The playback mismatch has independent reports, including Feedback ID
FB12353357, but the available evidence does not identify the cause on any
particular account or establish that a client can distinguish a false
restriction from a parental or family setting. Apple's DTS response requested
a focused report and said it found no documented way to clear the restriction.

The MusicKit v3 reference documents content restriction errors but does not
document the writable `restrictedEnabled` property. The Apple Developer Program
License Agreement's documented-use language therefore matters even though
other projects use the property. Precedent alone does not establish Apple
approval. Successful MusicKit authorization also does not show that the
authorized listener may change a protected account setting.

The audit found no supported signal that could safely enable an account-level
override. Arlet therefore keeps MusicKit's report intact and handles Clean
locally. Do not reconnect the dormant helper to production without a documented
Apple-supported API and a fresh review of the account-isolation behavior.

## Account changes

Every Apple authorization popup can select another account, including
**Sign in again** from a healthy or expired session. Before showing the popup,
Arlet fences account data. After authorization succeeds, it clears the previous
library cache, pins, and saved playback queue before loading the signed-in
account. **Sign in again** never restores the old pins or queue. A fresh Sign in
may re-add pinned playlists only when the signed-in account's library lookup
confirms those playlists are still owned. If clearing a category fails, that
category stays fenced until a retry succeeds. A cancelled popup does not commit
an account change.

## References

- [Apple Developer Forums report and DTS response](https://developer.apple.com/forums/thread/731897)
- [Second developer report](https://developer.apple.com/forums/thread/745551)
- [Apple Music web parental controls](https://support.apple.com/guide/music-web/set-or-change-parental-controls-apdmfc091c0a/web)
- [Apple Music Windows restrictions](https://support.apple.com/guide/music-windows/restrictions-settings-mus36e9c86e5/windows)
- [Apple Developer Program License Agreement](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/)
- [Apple Music catalog content ratings and equivalents](https://developer.apple.com/documentation/applemusicapi/managing-content-ratings-alternate-versions-and-equivalencies)
