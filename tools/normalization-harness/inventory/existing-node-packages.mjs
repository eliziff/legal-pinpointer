// Resolve only already-installed runtime packages; no installs or repo changes.
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const existing = createRequire(import.meta.url);
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':')) throw error;
    return { url: pathToFileURL(existing.resolve(specifier)).href, shortCircuit: true };
  }
}});
