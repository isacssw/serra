# Serra launch video

A 30-second product video, written as code with [Remotion](https://www.remotion.dev). It isn't part of the app or the
bot: it has its own `package.json` and lockfile, and nothing in `src/` or `app/` imports it. It reads one file from the
app, `app/renderer/ui/brand-icons.ts`, so the Slack, GitHub and Claude marks match the app's.

## Make it

```sh
cd video/launch
corepack pnpm install --frozen-lockfile
corepack pnpm audio            # synthesizes the music bed and UI sounds into public/audio/ (about 1 s)
corepack pnpm studio           # preview and scrub in the browser
corepack pnpm render [outDir]  # serra-launch.mp4 (1920×1080), serra-launch-square.mp4 (1080×1080), serra-launch-poster.png
```

`render` defaults to `out/`. Renders and generated audio are ignored by git; rebuild them from source.

## Where things are

| File | What |
|---|---|
| `src/timing.ts` | The one clock: 120 BPM, the ten beats and their start frames. Picture and sound both read it. |
| `src/kit.tsx` | Serra's dark tokens (from `app/renderer/styles.css`), motion helpers, the redrawn S mark, cards and graph nodes. |
| `src/scenes/` | The beats: `Intro` (hook, logo), `Steps` (01–03), `Payoff` (agents, chat, knowledge), `Outro` (app window, end card). |
| `src/Launch.tsx` | Lays the beats on the timeline with crossfades and places each UI sound on its frame. |
| `scripts/make-audio.ts` | The music and sound effects, synthesized from oscillators and noise. |
| `public/brand/wordmark.png` | The wordmark, cut from `assets/brand/serra-lockup.png` with its background keyed to alpha. |

## Look

Near-black canvas with a dot grid, the sidebar the same colour as the page, and green (Serra's "up") as the only accent.
Amber shows only in the opening problem beat. The text colours are the app's `ink`, `muted` and `faint` tokens, so every
line reads at 4.5:1 or better.

## Audio licence

There are no third-party samples or tracks. `scripts/make-audio.ts` makes every sound from scratch (sine and saw
oscillators, filtered noise, envelopes, a delay), so the music and effects are original to this repository and
dedicated to the public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).

## Licences of the tools

Remotion is free for individuals and companies of up to three people; larger companies need a
[company licence](https://www.remotion.dev/license). lucide-react is ISC. The brand marks are from Simple Icons (CC0),
as noted in `brand-icons.ts`.
