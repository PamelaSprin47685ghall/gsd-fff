import { ensureBundledExtensionPath } from './src/self-injection.js'
import fffExtension from './src/index.js'

ensureBundledExtensionPath(import.meta.url)

const registeredPluginApis = new WeakSet()

export default function (pi) {
  if (registeredPluginApis.has(pi)) return
  fffExtension(pi)
}
