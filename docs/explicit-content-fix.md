# Explicit content fix

Facts as of 2026-11-21.

## Problem

- MusicKit JS sign-in can return `itre=1` (content restricted) for some Apple Accounts that play explicit content in the Apple Music app and on music.apple.com.
- When that happens, MusicKit silently drops explicit songs from every queue.
- Tracked in Apple Feedback FB12353357 and in Apple Developer Forums threads on the same symptom.
- Apple's suggested fixes (Screen Time, tv.apple.com, and music.apple.com settings) did not help the owner's account.

## What Arlet does

- Sets MusicKit's own `restrictedEnabled` instance property. "Allow" sets it to `false`; "Clean" sets it to `true`; "Auto" leaves it alone.
- Off by default. It is turned on only after the user agrees in a dialog with a 15-second delay.
- Applies from the next Play.
- Never writes the flag while signed out. The saved choice is applied after sign-in.
- Resets to Auto when a different Apple Account signs in and on sign-out. Turning the fix off resets Allow to Auto; Clean stays.
- MusicKit keeps an override for the rest of the page session. After Arlet has written the flag, sign-out restarts Arlet, and starting a sign-in restarts Arlet first. A sign-in in the same page session would otherwise keep the old override and drop Apple's new report.
- Apple's documentation says MusicKit cannot authorize under-13 accounts, so the option should never be reachable for them. This is not visible in Apple's bundle and is unverified.
- Does not clear or replace the user token.

## How MusicKit handles the restriction

- Apple's report arrives only at sign-in. The authorize popup returns `restricted`, and `requestUserToken` stores it as localStorage `music.<team>.itre`. Nothing else refreshes it.
- Setting `restrictedEnabled` calls the storekit override, which latches. Later internal assignments, including the next sign-in's report, are ignored and not stored.
- The latch lasts until the page reloads. Sign-out deletes `itre` and clears the value, but not the latch.
- With a token and no stored `itre` or in-memory value, MusicKit guesses from the storefront. It treats these storefronts as restricted: `br ch gt hu id in it kr la lt my ru sg tr`. Others are unrestricted.
- `setQueue` copies the flag to the queue. It drops explicit items and raises `CONTENT_RESTRICTED` only when the queue ends up empty.
- Apple's server can still refuse a song (webPlayback failure 3082). MusicKit maps that to the same `CONTENT_RESTRICTED`. The client override cannot change it.

## Arlet's rule and logging

- No write while signed out.
- Sign-out restarts Arlet after an override.
- Before sign-in, Arlet restarts if an override was already written in this session.
- Each time the choice applies while signed in, a log line records the choice, Apple's stored report (`itre`), and MusicKit's effective value.

## If your account is wrongly restricted

Apple's report changes only at sign-in. After you change Apple-side settings, sign out and sign in again in Arlet.

Reported cures are unreliable:

- Screen Time: turn Content & Privacy on, set Clean then Explicit, restart the device.
- music.apple.com: turn Parental Controls on and set the least-restricted option in all three menus.

Each cure needs a sign-out and sign-in afterwards.

Apple DTS asked for a Feedback report with the storefront, the failing and playing catalog IDs, the account's content setting, and whether music.apple.com plays the same songs.

## Terms reviewed

- Apple Developer Program License Agreement 3.3.6(D) (MusicKit): no clause on content restrictions.
- Section 3.3.1(A) and its "only as permitted in the Documentation" wording: `restrictedEnabled` is not in the MusicKit v3 documentation.
- App Review Guideline 2.3.6 applies to App Store apps only.

We found no term that prohibits this.

## Precedent

- ListenBrainz sets `restrictedEnabled = false` for all users.
- decky-apple-music exists; its opt-in switch is unverified.
- vibez sets the same flag (PR 131, merged September 2026).

If Apple objects, the option will be removed in an update.

## Sources

- https://developer.apple.com/forums/thread/731897
- https://developer.apple.com/forums/thread/745551
- https://developer.apple.com/forums/thread/742998
- https://developer.apple.com/forums/thread/104301
- https://github.com/simonepelosi/vibez/pull/131
- https://github.com/glomatico/gamdl/issues/360
- https://github.com/p2o51/Yoin/pull/173
- ListenBrainz `frontend/js/src/common/brainzplayer/AppleMusicPlayer.tsx`
