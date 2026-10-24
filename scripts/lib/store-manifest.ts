/** Store-assigned identities differ from the pinned unpacked development ID. */
export function storeManifest(source: Record<string, unknown>, version: string): Record<string, unknown> {
  const { key: _developmentKey, ...manifest } = source;
  return { ...manifest, version };
}
