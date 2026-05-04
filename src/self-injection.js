import path from "node:path";
import { fileURLToPath } from "node:url";

export function ensureBundledExtensionPath(metaUrl) {
  const entryFile = fileURLToPath(metaUrl);
  const entryDir = path.dirname(entryFile);
  const normalizeEntry = entry => {
    try {
      const resolved = path.resolve(entry);
      if (resolved === entryDir || resolved === entryFile) return entryFile;
      return resolved;
    } catch {
      return entry;
    }
  };

  const currentValue = process.env.GSD_BUNDLED_EXTENSION_PATHS || "";
  const entries = currentValue
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(normalizeEntry);
  const nextEntries = entries.includes(entryFile) ? entries : [...entries, entryFile];
  const nextValue = nextEntries.join(path.delimiter);

  if (nextValue !== currentValue) {
    process.env.GSD_BUNDLED_EXTENSION_PATHS = nextValue;
  }

  return entryFile;
}
