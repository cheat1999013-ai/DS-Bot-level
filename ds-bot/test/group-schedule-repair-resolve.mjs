import './harness-resolve.mjs'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
const appRoot = process.env.DSH_APP_ROOT
if (!appRoot) throw new Error('Set DSH_APP_ROOT to the DSH desktop app folder')
const anchor = pathToFileURL(`${appRoot}/package.json`).href
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context) }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:') || specifier.startsWith('file:')) throw error
    return nextResolve(specifier, { ...context, parentURL: anchor })
  }
} })
