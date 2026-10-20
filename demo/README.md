# Demo sources

The README GIF, MP4 and social card are generated from the same deterministic HTML timeline. No
screen recording and no random timing: every frame is rendered from `renderAt(t)` in `demo.html`, so the
result can be rebuilt exactly.

| File | What it is |
|---|---|
| `demo.html` | 13-second animated demo (1600×900 stage) |
| `social.html` | 1280×640 social card |
| `backdrop.jpg` | clean crop of the wallpaper, no desktop UI |
| `render.mjs` | headless Chrome frame renderer (CDP) |
| `../assets/qurp-demo.gif` | 1024×576, 20 fps, 258 frames |
| `../assets/qurp-demo.mp4` | 1920×1080, 24 fps, H.264 |
| `../assets/qurp-social.png` | 1280×640 social preview |

## Requirements

- Node.js 22+ (for the built-in WebSocket used by `render.mjs`)
- Google Chrome or Chromium
- FFmpeg
- [gifski](https://gif.ski/) for the GIF (`cargo install gifski --locked`)
- Cantarell and Noto Color Emoji fonts (GNOME systems already have them)

## Rebuild the frames

```bash
# 312 frames at 24 fps, supersampled 1.5× (2400×1350)
node demo/render.mjs --all --out=demo/frames --fps=24 --scale=1.5
```

Use `--times=1.2,4.7,11.5 --out=/tmp/preview --scale=1` to render only a few stills.

## GIF

GIF needs a 20 fps input sequence; gifski keeps every input frame, so resample first:

```bash
mkdir -p demo/gif-frames
ffmpeg -y -framerate 24 -i demo/frames/frame_%04d.png \
  -vf "fps=20,scale=1280:720:flags=lanczos" demo/gif-frames/f_%04d.png

gifski --fps 20 --width 1024 --quality 100 --lossy-quality 100 \
  --output assets/qurp-demo.gif demo/gif-frames/f_*.png
```

`--quality 100 --lossy-quality 100` matters. Lower quality values make gifski reuse too many pixels in
the dark fades and leave faint "ghost" text from earlier captions. Quality 100 gives a clean 8.5 MB GIF.

## MP4 (social video)

```bash
ffmpeg -y -framerate 24 -i demo/frames/frame_%04d.png \
  -vf "scale=1920:1080:flags=lanczos" \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart \
  assets/qurp-demo.mp4
```

## Social card

```bash
google-chrome --headless=new --hide-scrollbars --disable-gpu \
  --force-device-scale-factor=2 --window-size=1280,640 \
  --virtual-time-budget=2500 \
  --screenshot=/tmp/qurp-social-2x.png \
  "file://$PWD/demo/social.html"

ffmpeg -y -i /tmp/qurp-social-2x.png -vf "scale=1280:640:flags=lanczos" assets/qurp-social.png
```

## Editing the story

Everything is driven by time constants at the bottom of `demo.html` (`setStyles(t)`):

- `0–2.5s` intro
- `2.5–4.6s` Quick Settings tile → Qurp panel
- `4.6–7.8s` pick Germany, connect (ripple, spinner, green state)
- `7.7–9.9s` feature callouts
- `9.9–13.0s` install / repo end card

If you change the timeline, keep the final `#fade` reaching full black at `13.0s` and the first frame
black; that makes the GIF loop seamlessly.
