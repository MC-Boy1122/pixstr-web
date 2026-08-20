import { strict as assert } from 'node:assert'
import {
  TT_TYPES,
  tagFor,
  typeFromTag,
  detectType,
  encodeText,
  decodeText,
  seal,
  sealPayload,
  unseal,
  unsealPayload,
} from '../web/src/lib/textcodec.js'

import { stripTag } from '../web/src/lib/utils.js'
const stripTagFrom = (s) => stripTag(s)

let passed = 0
const ok = (name) => { passed++; console.log('  ok  ' + name) }

function roundTrip(text, type) {
  const enc = encodeText(text, type)
  const dec = decodeText(enc, type)
  assert.strictEqual(dec, text, `round-trip ${type}`)
  ok(`${type} round-trip: ${JSON.stringify(text)}`)
}

console.log('codec round-trips (UTF-8 incl.)')
roundTrip('Hello, World!', 'base64')
roundTrip('hello', 'base32')
roundTrip('68656c6c6f', 'hex')
roundTrip('xK#0@zVx+q', 'z85')
roundTrip('PixStr 画像 → テキスト 🚀', 'base64')
roundTrip('你好，世界', 'z85')

console.log('tag helpers')
assert.strictEqual(tagFor('base64'), 'Base64')
assert.strictEqual(tagFor('sealed'), 'Sealed')
assert.strictEqual(typeFromTag('Z85'), 'z85')
assert.strictEqual(typeFromTag('Base32'), 'base32')
assert.strictEqual(typeFromTag('NOPE'), null)
ok('tagFor/typeFromTag (incl. case-insensitive)')

console.log('detectType heuristics')
assert.strictEqual(detectType('dGVzdA=='), 'base64')
assert.strictEqual(detectType('JBSWY3DPFQQFO33SNRSCC==='), 'base32')
assert.strictEqual(detectType('ab'), 'hex')
assert.strictEqual(detectType('a'), null)
assert.strictEqual(detectType('~~~~~~~~~~'), null)
assert.strictEqual(detectType('W0Juhc2U2NF0gU0dWc2BJHOHNJRmRM2Y214a0lRPbT0D5zW'), 'sealed')
assert.strictEqual(typeFromTag(stripTagFrom('[Sealed] x').tag), 'sealed')
ok('detectType (b64, 6-= base32, single-char hex, garbage, sealed)')

console.log('SEAL canonical vectors (from AGENTS.md / Rust impl)')
const vectors = [
  ['W0Juhc2U2NF0gU0dWc2BJHOHNJRmRM2Y214a0lRPbT0D5zW', '[Base64] SGVsbG8sIFdvcmxkIQ==', 'Hello, World!'],
  ['/cW0pQFRL10gYHUdWc2JHhODo0S/7z/', '[JPG] aGVsbG8=', 'hello'],
  ['W0hleF0gNjg2wNTZjNmM2ZgABAB', '[Hex] 68656c6c6f', 'hello'],
  ['etEsxjMEB6Vn5gir0cQc9+/9', 'xK#0@zVx+q', 'hello'],
]
for (const [payload, inner, plaintext] of vectors) {
  const unsealed = unsealPayload(payload)
  assert.strictEqual(unsealed, inner, `unseal ${payload.slice(0, 8)}…`)
  const { tag, rest } = stripTag(unsealed)
  const type = (tag ? typeFromTag(tag) : null) ?? detectType(rest) ?? 'base64'
  const dec = decodeText(rest, type)
  assert.strictEqual(dec, plaintext, `decode ${payload.slice(0, 8)}…`)
  ok(`vector ${payload.slice(0, 8)}… → ${JSON.stringify(plaintext)}`)
}

console.log('seal round-trips')
for (const type of ['base64', 'base32', 'hex', 'z85']) {
  const tagged = '[' + tagFor(type) + '] ' + encodeText('hello seal test', type)
  const s = seal(tagged)
  const back = unseal(s)
  assert.strictEqual(back, tagged, `unseal ${type}`)
  const dec = decodeText(s, 'sealed')
  assert.strictEqual(dec, 'hello seal test', `decode sealed ${type}`)
}
ok('seal → unseal → decode for all 4 codecs')

console.log('invalid input handling')
assert.strictEqual(decodeText('!!!!!', 'base64'), 'Invalid Base64 input')
assert.strictEqual(decodeText('[Sealed] abc', 'sealed'), 'Invalid Sealed input')
assert.strictEqual(unsealPayload('ab'), null)
ok('errors propagate')

console.log(`\nALL PASS (${passed} checks)`)
