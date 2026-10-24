import type { Config } from '@claude-browser/shared';

/** Assigned Chrome Web Store item ID; the public listing may appear after review. */
export const RELEASED_CHROME_EXTENSION_ID = 'kglhakgapoegbnnbobnmnebmbljehcid';
export const RELEASED_CHROME_STORE_URL = `https://chromewebstore.google.com/detail/${RELEASED_CHROME_EXTENSION_ID}`;

/** Apply release defaults at runtime without changing an existing companion file. */
export function withReleaseDefaults(config: Config): Config {
  return {
    ...config,
    extensionIds: [...new Set([RELEASED_CHROME_EXTENSION_ID, ...(config.extensionIds ?? [])])],
    storeUrls: { chrome: RELEASED_CHROME_STORE_URL, ...config.storeUrls },
  };
}
