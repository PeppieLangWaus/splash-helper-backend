import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import extractZip from 'extract-zip';

/**
 * Renders an icon PNG for every named OSRS item and copies them into data/item-icons/, for
 * routes/items.ts (`GET /items/:id/icon`) to serve.
 *
 * This is an offline maintenance step, not something the live server ever runs itself: run it
 * manually (or via CI) after a game update adds/changes items, then commit the changed
 * data/item-icons/*.png files. Trimmed port of RuneProfile's scripts/ts-scripts/sync-item-icons.ts
 * + lib/openrs2.ts — cache download -> Java render -> copy, no R2/CDN upload, diffing, or
 * sprite-atlas compositing (see scripts/item-icons/README.md for what else was dropped and why).
 * Icons are rendered to match RuneProfile's own (quantity 10000 + its quantities.json overrides,
 * so stackable items show their full-stack sprite variant) rather than a bare single unit.
 *
 * Usage:
 *   npm run render-item-icons                          # latest live cache from OpenRS2
 *   npm run render-item-icons -- --cache-dir <path>     # skip download, render from an existing disk store
 *   npm run render-item-icons -- --ids 995,4151         # only these item IDs (fast smoke test)
 *   npm run render-item-icons -- --build-cache <dir>    # see "Build cache" below
 *
 * Requires a JDK (11+, on PATH or via JAVA_HOME).
 *
 * ## Build cache
 *
 * `--build-cache <dir>` (used by the Dockerfile, via a BuildKit `--mount=type=cache`) skips the
 * download + render entirely when OpenRS2's latest live cache id is the same one recorded in
 * `<dir>/cache-version.txt` from a previous run, reusing the icons saved in `<dir>/icons/`
 * instead. It only applies to a full "latest cache, every item" run — it's ignored if `--cache-dir`
 * or `--ids` is also passed, since neither produces output safe to treat as a complete build-cache
 * entry.
 */

const OPENRS2_CACHES_URL = 'https://archive.openrs2.org/caches.json';

const RENDERER_DIR = path.resolve(__dirname, 'item-icons');
const WORK_DIR = path.join(RENDERER_DIR, 'work');
const OUT_DIR = path.resolve(__dirname, '..', 'data', 'item-icons');

const argValue = (flag: string): string | null => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1] ?? null;
};
const cacheDirArg = argValue('--cache-dir');
const idsArg = argValue('--ids');
const buildCacheArg = argValue('--build-cache');

interface Openrs2Cache {
  id: number;
  scope: string;
  timestamp: string;
}

// The OpenRS2 archive (https://archive.openrs2.org) mirrors every OSRS cache straight from
// Jagex's JS5 servers, within minutes of a game update.
async function resolveLatestCache(): Promise<Openrs2Cache> {
  const response = await fetch(OPENRS2_CACHES_URL);
  if (!response.ok) {
    throw new Error(`OpenRS2 caches.json returned ${response.status}`);
  }
  const caches: Array<{
    id: number;
    scope: string;
    game: string;
    environment: string;
    language: string;
    timestamp: string | null;
    disk_store_valid: boolean;
  }> = await response.json();

  const latest = caches
    .filter((c) => c.game === 'oldschool' && c.environment === 'live' && c.language === 'en' && c.disk_store_valid && c.timestamp)
    .sort((a, b) => new Date(b.timestamp as string).getTime() - new Date(a.timestamp as string).getTime())[0];
  if (!latest) {
    throw new Error('No valid live oldschool cache found on OpenRS2.');
  }
  return { id: latest.id, scope: latest.scope, timestamp: latest.timestamp as string };
}

// Downloads and extracts a cache's disk store into destDir; returns the directory containing
// main_file_cache.dat2 (+ .idx files).
async function downloadCache(cache: Openrs2Cache, destDir: string): Promise<string> {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });

  const zipPath = path.join(destDir, 'disk.zip');
  const downloadUrl = `https://archive.openrs2.org/caches/${cache.scope}/${cache.id}/disk.zip`;
  console.log(`Downloading ${downloadUrl}...`);
  const download = await fetch(downloadUrl);
  if (!download.ok || !download.body) {
    throw new Error(`Cache download returned ${download.status}`);
  }
  await pipeline(Readable.fromWeb(download.body as never), createWriteStream(zipPath));

  await extractZip(zipPath, { dir: destDir });
  const cacheDir = path.join(destDir, 'cache');
  if (!existsSync(path.join(cacheDir, 'main_file_cache.dat2'))) {
    throw new Error(`Extracted cache not found at ${cacheDir}`);
  }
  return cacheDir;
}

// Runs the Java renderer (scripts/item-icons) against a disk store; returns the directory it
// wrote {itemId}.png files to.
function renderIcons(cacheDir: string): string {
  const outDir = path.join(WORK_DIR, 'icons');
  const quantitiesPath = path.join(RENDERER_DIR, 'quantities.json');
  const rendererArgs = idsArg
    ? `${cacheDir} ${outDir} ${quantitiesPath} ${idsArg}`
    : `${cacheDir} ${outDir} ${quantitiesPath}`;
  // Gradle's `--args` takes one space-separated string, itself containing multiple app args — on
  // Windows that whole thing has to survive as a single token once `shell: true` (required to exec
  // a .bat at all) naively re-joins our argv with spaces, so it's quoted here ourselves.
  const argsFlag = process.platform === 'win32' ? `--args="${rendererArgs}"` : `--args=${rendererArgs}`;
  console.log('Rendering item icons...');
  execFileSync(
    process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew',
    ['--no-daemon', '-q', 'run', argsFlag],
    // Windows can't exec a .bat directly without going through a shell.
    { cwd: RENDERER_DIR, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  return outDir;
}

function copyIcons(iconsDir: string): number {
  mkdirSync(OUT_DIR, { recursive: true });
  const files = readdirSync(iconsDir).filter((f) => /^\d+\.png$/.test(f));
  for (const file of files) {
    copyFileSync(path.join(iconsDir, file), path.join(OUT_DIR, file));
  }
  return files.length;
}

async function resolveCacheDir(): Promise<string> {
  if (cacheDirArg) return cacheDirArg;
  console.log('Finding the latest live cache on OpenRS2...');
  const latest = await resolveLatestCache();
  console.log(`Using cache ${latest.id} (${latest.timestamp})`);
  return downloadCache(latest, WORK_DIR);
}

// The cache id (not the icons themselves) is what actually changes when OSRS ships an update, so
// that's what's compared build-to-build; `<dir>/icons/` just carries the render that id produced.
function readCachedCacheId(buildCacheDir: string): number | null {
  const versionFile = path.join(buildCacheDir, 'cache-version.txt');
  if (!existsSync(versionFile)) return null;
  const id = Number(readFileSync(versionFile, 'utf8').trim());
  return Number.isInteger(id) ? id : null;
}

function reuseFromBuildCache(buildCacheDir: string): number {
  const savedIconsDir = path.join(buildCacheDir, 'icons');
  if (!existsSync(savedIconsDir)) return 0;
  mkdirSync(OUT_DIR, { recursive: true });
  const files = readdirSync(savedIconsDir).filter((f) => /^\d+\.png$/.test(f));
  for (const file of files) {
    copyFileSync(path.join(savedIconsDir, file), path.join(OUT_DIR, file));
  }
  return files.length;
}

function saveToBuildCache(buildCacheDir: string, cacheId: number): void {
  const savedIconsDir = path.join(buildCacheDir, 'icons');
  rmSync(savedIconsDir, { recursive: true, force: true });
  mkdirSync(savedIconsDir, { recursive: true });
  const files = readdirSync(OUT_DIR).filter((f) => /^\d+\.png$/.test(f));
  for (const file of files) {
    copyFileSync(path.join(OUT_DIR, file), path.join(savedIconsDir, file));
  }
  writeFileSync(path.join(buildCacheDir, 'cache-version.txt'), String(cacheId));
}

async function main(): Promise<void> {
  // When --build-cache applies, resolve the latest cache id up front so it can be compared
  // against what's recorded from the last run before deciding whether to download anything at all.
  let latestForBuildCache: Openrs2Cache | null = null;

  if (buildCacheArg && !cacheDirArg && !idsArg) {
    console.log('Finding the latest live cache on OpenRS2...');
    const latest = await resolveLatestCache();
    const cachedId = readCachedCacheId(buildCacheArg);

    if (cachedId === latest.id) {
      const count = reuseFromBuildCache(buildCacheArg);
      if (count > 0) {
        console.log(
          `Cache ${latest.id} is unchanged since the last build — reusing ${count} icon${count === 1 ? '' : 's'} from the build cache, skipping download + render.`,
        );
        return;
      }
      console.log(`Build cache for cache ${latest.id} has no saved icons — rendering anyway.`);
    } else {
      console.log(
        cachedId === null
          ? 'No previous build-cache entry found — rendering from scratch.'
          : `Cache changed since the last build (${cachedId} -> ${latest.id}) — rendering from scratch.`,
      );
    }
    latestForBuildCache = latest;
  }

  const cacheDir = latestForBuildCache ? await downloadCache(latestForBuildCache, WORK_DIR) : await resolveCacheDir();
  const iconsDir = renderIcons(cacheDir);

  const count = copyIcons(iconsDir);
  if (count === 0) {
    throw new Error(`No rendered icons found in ${iconsDir}`);
  }
  console.log(`Copied ${count} item icon${count === 1 ? '' : 's'} into ${OUT_DIR}`);

  if (buildCacheArg && latestForBuildCache) {
    saveToBuildCache(buildCacheArg, latestForBuildCache.id);
    console.log(`Saved cache ${latestForBuildCache.id}'s icons into the build cache for future builds.`);
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exitCode = 1;
});
