import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { SKIN_ASSETS } from '../../lib/skin-assets.js'

const client = fs.readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')
const css = fs.readFileSync(new URL('../../skins/iter5/native-solid.css', import.meta.url), 'utf8')
const generator = fs.readFileSync(new URL('../../tools/build-iter5-skin.mjs', import.meta.url), 'utf8')
const migration = client.slice(client.indexOf(';(function migratePersonalisedStorage()'), client.indexOf('// DSH-PERSONALISED END browser-state migration.'))
assert.ok(migration.length > 100)
assert.ok(client.indexOf(migration) < client.indexOf('localStorage.getItem(PIN_KEY)'))
function storage(entries, failOnce = false) {
  const values = new Map(entries)
  return { values, get length() { return values.size }, key(i) { return [...values.keys()][i] }, getItem(k) { return values.get(k) ?? null }, setItem(k, v) { if (failOnce) { failOnce = false; throw Error('quota') } values.set(k, String(v)) } }
}
const old = storage([['dsh-auto-memory.panel.pinned', '1'], ['dsh-auto-memory-pre.panel.geom', 'geometry'], ['dsh-auto-memory.fontScale.v2', 'lg'], ['dsh-personalised.fontScale.v2', 'sm']])
vm.runInNewContext(migration, { localStorage: old })
assert.equal(old.getItem('dsh-personalised.panel.pinned'), '1')
assert.equal(old.getItem('dsh-personalised.panel.geom'), 'geometry')
assert.equal(old.getItem('dsh-personalised.fontScale.v2'), 'sm')
assert.equal(old.getItem('dsh-auto-memory.panel.pinned'), '1')
const retry = storage([['dsh-auto-memory.panel.pinned', '1']], true)
vm.runInNewContext(migration, { localStorage: retry })
assert.equal(retry.getItem('dsh-personalised.panel.pinned'), null)
vm.runInNewContext(migration, { localStorage: retry })
assert.equal(retry.getItem('dsh-personalised.panel.pinned'), '1')
assert.match(client, /var ROUTE_PREFIX = '\/api\/dsh-personalised'/)
assert.match(client, /client v1\.0\.0 fingerprint/)
assert.match(client, /data-slot-id=personalised-panel/)
assert.match(client, /id: 'personalised-panel'/)
for (const selector of ['[data-dam-panel]', '[data-dam-tour]', '[data-dam-status-dialog]', '[data-native-dialog]', '[data-native-continuation]', '[data-dam-autocont]', '.i5-dialog', '[data-dam-calendar-modal]', '[data-dam-kx-drawer]', '[data-dam-wbg-side]', '[data-dam-savebar]', '[role=menu]', '[role=tooltip]']) assert.ok(css.includes(selector), selector)
assert.match(css, /background:var\(--dsw-alias-bg-layer-2\)!important/)
assert.match(css, /opacity:1!important/)
assert.match(css, /backdrop-filter:none!important/)
assert.doesNotMatch(css, /--dsw-alias-[\w-]+\s*:/)
assert.doesNotMatch(css, /(?:^|\n)\s*(?:body|html|:root)\b/)
assert.ok(generator.includes("+ '\\n' + nativeSolidCss"))
for (const entry of Object.values(SKIN_ASSETS)) for (const key of ['file', 'fileDark']) if (entry[key]) assert.ok(fs.existsSync(new URL('../../lib/assets/skin/' + entry[key], import.meta.url)), entry[key])
console.log('PASS personalised solid: early migration, precedence, rollback, retry, brand, scoped opaque surface coverage, asset references')
