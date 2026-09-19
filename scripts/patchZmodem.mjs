import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const packagePath = new URL('../node_modules/zmodem.js/package.json', import.meta.url)
const sentryPath = new URL('../node_modules/zmodem.js/src/zsentry.js', import.meta.url)
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))

if (packageJson.version !== '0.1.10') {
  throw new Error(`Expected zmodem.js 0.1.10, found ${packageJson.version}`)
}

const sentry = await readFile(sentryPath, 'utf8')
const original = '        cache.splice( MAX_ZM_HEX_START_LENGTH );'
const patched = `        // Keep an incomplete ZMODEM header across SSH chunks. Otherwise the
        // cache trim keeps the beginning of the previous chunk and loses a
        // marker split across two channel data events.
        let keep_from = cache.length;
        let marker_at = Zmodem.ZMLIB.find_subarray(cache, COMMON_ZM_HEX_START);
        if (marker_at >= 0) {
            keep_from = cache.length - marker_at < MAX_ZM_HEX_START_LENGTH
                ? marker_at
                : cache.length - (COMMON_ZM_HEX_START.length - 1);
        }
        else if (marker_at < 0) {
            const max_prefix = Math.min(cache.length, COMMON_ZM_HEX_START.length - 1);
            for (let length = max_prefix; length > 0; length--) {
                let matches = true;
                for (let index = 0; index < length; index++) {
                    if (cache[cache.length - length + index] !== COMMON_ZM_HEX_START[index]) {
                        matches = false;
                        break;
                    }
                }
                if (matches) {
                    keep_from = cache.length - length;
                    break;
                }
            }
        }
        if (keep_from > 0) cache.splice(0, keep_from);`

if (sentry.includes(patched)) {
  console.log('zmodem.js split-header patch is already applied.')
} else if (sentry.split(original).length === 2) {
  await writeFile(sentryPath, sentry.replace(original, patched))
  console.log('Applied the zmodem.js split-header cache fix.')
} else {
  throw new Error('Could not locate the expected zmodem.js 0.1.10 Sentry cache trim')
}

// Verify the patch target is the packaged runtime copy, not another checkout.
console.log(`Patched ${fileURLToPath(sentryPath)}`)
