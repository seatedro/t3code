# Flock icon

Fork-only app icon. `flock.svg` is the source, drawn on the macOS grid (824×824 body inset 100px with its shadow). `scripts/lib/fork-brand.ts` points nightly and production builds at these files; development builds keep upstream's icons.

The other files are rendered from it with `resvg`: `flock-macos-1024.png` as is, and the rest from a full-bleed copy (viewBox `100 100 824 824`, no shadow). The `.ico` files embed PNGs at 16, 24, 32, 48, 64, 128 and 256 px.
