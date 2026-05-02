# SystemAudioCapture

A small macOS command-line helper that captures system audio (everything the
user hears — Zoom, Google Meet, browser tabs, etc.) using Apple's
**ScreenCaptureKit** API and writes raw 16-bit little-endian mono PCM to
`stdout`.

The parent Electron app (`com.harjyot.personal-meeting-os`) spawns this binary
and pipes its `stdout` directly into the Deepgram streaming service.

## Why ScreenCaptureKit

On macOS 13+ ScreenCaptureKit can capture audio from running applications
without requiring users to install a virtual audio device like BlackHole or
Loopback. The user grants Screen Recording permission once, and that's it.

## Build

Requires Xcode command-line tools and Swift 5.9+ (ships with macOS 13+ Xcode).

```sh
cd native/SystemAudioCapture
swift build -c release
```

The release binary lands at:

```
.build/release/SystemAudioCapture
```

The Electron build copies it to:

```
resources/bin/system-audio-capture
```

## Usage

```sh
./SystemAudioCapture --rate 16000 > /tmp/out.pcm
```

Flags:

- `--rate <hz>` — output sample rate (default `16000`). Typical values are
  `16000` (Deepgram low-latency) or `48000`.
- `--exclude <bundleID>` — exclude a specific app's audio from the capture.
  May be passed multiple times. The helper always excludes its parent
  Electron app (`com.harjyot.personal-meeting-os`) automatically to prevent
  feedback loops.

Output on stdout is raw PCM:

- format: signed 16-bit little-endian
- channels: 1 (mono; the system mix is downmixed)
- sample rate: whatever you passed to `--rate`

Diagnostic and error messages are written to **stderr** only — `stdout` is
guaranteed to contain only PCM bytes.

## macOS permissions

The first time the parent Electron app launches this helper it will fail
because macOS requires **Screen Recording** permission to capture system
audio via ScreenCaptureKit (audio capture is gated on the same permission as
display capture, since they share the same API).

To grant permission:

1. Open **System Settings → Privacy & Security → Screen Recording**.
2. Enable the toggle next to **Personal Meeting OS** (the parent Electron app).
3. Restart the app.

Subsequent launches will succeed.

> Note: the permission is attached to the **parent** application bundle
> (the Electron app), not to this helper binary directly. If you run the
> helper standalone from a terminal, the terminal app needs Screen Recording
> permission instead.

## Signals

The helper handles `SIGINT` and `SIGTERM` and stops the capture stream
cleanly before exiting. `SIGPIPE` (parent closed its end) is also handled
and causes a clean exit.
