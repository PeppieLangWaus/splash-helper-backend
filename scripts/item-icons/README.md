# item-icons

Headless renderer that produces a single-item icon PNG (36×32) for every named item in an OSRS
cache, using RuneLite's own cache-parsing library (`net.runelite:cache`) — the same rasterizer the
client itself uses for item icons. Ported from [RuneProfile's `scripts/item-icons`](https://github.com/ReinhardtR/runeprofile/tree/main/scripts/item-icons)
and trimmed down to just this backend's actual need: a `GET /items/:id/icon` lookup for icons
shown in the relayed-chat viewer.

Not run directly — see `../render-item-icons.ts` (`npm run render-item-icons` from the repo root),
which downloads a cache from [OpenRS2](https://archive.openrs2.org), invokes this via Gradle, and
copies the results into `../../data/item-icons/`, which `src/routes/items.ts` serves from.

## What's different from RuneProfile's version

- No `DumpHiscoreIcons`/`DumpClanRankIcons` — this repo's FC/CC rank icons already come from the
  OSRS Wiki (`src/services/rankIcons.ts`), so there's nothing here that needs the `net.runelite:client`
  dependency those pull in.
- No R2/CDN upload or MD5-diffing — icons are copied straight into this repo's own `data/item-icons/`
  and served by the Node app itself, committed like the rest of the repo's static test data.
- No collection-log sprite-atlas compositing — that's specific to RuneProfile's collection log page.
- Renders at quantity 1 (a plain single-item icon) instead of a full 10000-stack variant, so there's
  no `quantities.json` override table either — a chat-message icon doesn't need a stack-count overlay.

## Requirements

- A JDK, 11 or newer (the `net.runelite:cache` jar itself is built for 11).
- Nothing else — the Gradle wrapper (`gradlew`/`gradlew.bat`) downloads the rest.

## Running directly

```
./gradlew run --args="<cacheDir> <outDir> [ids]"
```

- `cacheDir` — a Jagex disk store directory (`main_file_cache.dat2` + `.idx*` files), e.g. an
  OpenRS2 `disk.zip` extracted.
- `outDir` — where to write `{itemId}.png` files.
- `ids` (optional) — comma-separated item IDs to render only a subset, for a fast local check
  instead of waiting through a full ~4000-item render (e.g. `995,4151` for coins + abyssal whip).
