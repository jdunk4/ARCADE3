# Soundtrack + Phone Ring + Volume Controls

Drop-in audio update for Meebit Shooter.

## What's new

**🎵 Four arena tracks cycle with the waves.**
`Arena I.mp3` plays on wave 1, `Arena II.mp3` on wave 2, and so on.
Track 5 loops back to Arena I. Each track cross-fades smoothly into
the next — no jarring cut.

**📞 Real phone ring on the incoming-call screen.**
`PHONE RINGS.mp3` loops while the call screen is up, and stops the
moment the player accepts, declines, or starts the game.

**🎚️ Independent volume sliders in the Escape menu.**
Press Escape during a run to pause. Two sliders control Soundtrack and
SFX volume independently, plus a Mute All toggle and a Quit-to-Title
button. Preferences persist in `localStorage` across sessions.

## Files

```
src/audio.js          ← FULL REPLACEMENT
src/pauseMenu.js      ← NEW FILE
src/main.js           ← 6 SMALL PATCHES (see docs/main.js.PATCH.md)
```

No changes needed to `index.html`, `styles.css`, `scene.js`, `state.js`,
`ui.js`, `player.js`, `waves.js`, `blocks.js`, `spawners.js`, `orbs.js`,
`save.js`, or any other file.

## Asset paths

The new `audio.js` expects these files (already in the repo):

```
Meebit-Shooter/assets/Arena I.mp3
Meebit-Shooter/assets/Arena II.mp3
Meebit-Shooter/assets/Arena III.mp3
Meebit-Shooter/assets/Arena IV.mp3
Meebit-Shooter/assets/PHONE RINGS.mp3
```

Filename spaces are fine — the browser URL-encodes them automatically.

## Preferences storage key

`localStorage['meebit_audio_prefs_v1']` holds:

```json
{ "sfxVolume": 0.7, "musicVolume": 0.5, "muted": false }
```

Delete that key to reset to defaults.

## Tuning

- **Track defaults**: change the initial `sfxVolume` / `musicVolume`
  in the `AudioEngine` constructor.
- **Cross-fade length**: `_fadeIn` and `_fadeOutAndPause` control fade
  timing. Defaults are 800 ms in, ~500 ms out.
- **Track-per-chapter instead of track-per-wave**: change the `idx`
  formula in `startMusic()` from `(wave - 1) % 4` to
  `(Math.floor((wave - 1) / 5)) % 4` — each chapter (5 waves) gets
  its own arena track.
- **Random track order**: replace the `idx` calculation with
  `Math.floor(Math.random() * this._trackEls.length)`.

## Why HTMLAudio instead of Web Audio for MP3s?

Streaming a multi-minute MP3 via `decodeAudioData` forces the whole
file into memory decoded, which is wasteful. `<audio>` elements stream
naturally, give us `.volume` for free, and handle looping cleanly.
They live alongside the WebAudio SFX graph — sounds route through the
graph, music does not.

## Known quirks

- Browsers block autoplay until the user interacts once. The phone
  ring triggers right after the user clicks through to the title
  screen, so it should almost always succeed — but if a silent call
  screen ever appears in production, that's a user-gesture issue, not
  a bug in this code. The `.play()` promise is caught silently.
- If the user mutes via the OS or browser tab, the sliders still work
  but produce no sound. Our mute toggle is independent of OS mute.
