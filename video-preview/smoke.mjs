// Exercise the browser half of @local/dsh-video-preview without a browser:
// capture the module registration, run apply() against a stub client context, render the
// body's initial state through a tiny JSX serializer, and check the pure helpers.
// (react is prebundled into the client shell, so there is no node package to import.)
const bundleClient = new URL('./lib/client.js', import.meta.url)
const registrations = []
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration)
    },
  },
}
globalThis.document = {
  baseURI: 'http://127.0.0.1:3080/',
  createElement: () => ({ style: {}, setAttribute() {}, select() {}, remove() {} }),
  body: { appendChild() {} },
  execCommand: () => false,
}
if (!globalThis.navigator) globalThis.navigator = {}

await import(bundleClient.href)
if (registrations.length !== 1) throw new Error(`expected one registration, got ${registrations.length}`)
const registration = registrations[0]
console.log('module id:', registration.id)

// Minimal React surface: enough for a single render pass of MediaBody.
const stateInitials = ["probing", undefined, 0, "", "", "", 0, 0]
let stateIndex = 0
const reactStub = {
  useState() {
    const value = stateInitials[stateIndex]
    stateIndex += 1
    return [value, () => {}]
  },
  useMemo(factory) {
    return factory()
  },
  useCallback(fn) {
    return fn
  },
  useEffect() {},
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } }
  },
  Fragment: Symbol('Fragment'),
}
const Fragment = reactStub.Fragment
const jsxRuntimeStub = {
  jsx: (type, props) => ({ type, props: props ?? {} }),
  jsxs: (type, props) => ({ type, props: props ?? {} }),
  Fragment,
}
const shimRequire = (specifier) => {
  if (specifier === 'react') return reactStub
  if (specifier === 'react/jsx-runtime') return jsxRuntimeStub
  throw new Error(`unexpected require: ${specifier}`)
}
const exportsObject = registration.factory(shimRequire)
console.log('exports:', Object.keys(exportsObject).join(', '))
const helpers = exportsObject.__test
if (helpers === undefined) throw new Error('helpers not exported')

const previews = []
const slots = []
let localeRegistrations = 0
const t = (key, values) => (values === undefined ? `t:${key}` : `t:${key}(${JSON.stringify(values)})`)
const ctx = {
  effect(fn) {
    return fn()
  },
  locale: {
    register(namespace, dictionaries) {
      localeRegistrations += 1
      if (!dictionaries.zh || !dictionaries.en) throw new Error('locale dictionaries incomplete')
      return () => {}
    },
    bind() {
      return t
    },
  },
  documentPreviews: {
    register(definition) {
      previews.push(definition)
      return () => {}
    },
  },
  slots: {
    inject(name, register) {
      if (name !== 'sidebar.right.tab.document') throw new Error(`unexpected slot ${name}`)
      return register()
    },
    register(options, component) {
      slots.push({ options, component })
      return () => {}
    },
  },
  remote: { session: { openWorkspacePath: async () => ({ opened: true }) } },
}
exportsObject.apply(ctx)
console.log('locale registrations:', localeRegistrations)
console.log('previews:', previews.map((d) => `${d.id} extensions=${d.extensions.length} binary=${d.binaryExtensions.length} priority=${d.priority} loading=${d.loading}`).join(' | '))
console.log('slots:', slots.map((s) => `${s.options.name} key=${s.options.key} locale=${s.options.locale}`).join(' | '))
if (slots.length !== 1) throw new Error('slot body not registered')
const definition = previews[0] ?? {}
for (const suffix of ['mp4', 'webm', 'mov', 'm4v', 'mkv']) {
  if (!definition.extensions.includes(suffix)) throw new Error(`missing video suffix ${suffix}`)
}
for (const suffix of ['mp3', 'wav', 'm4a', 'flac']) {
  if (!definition.extensions.includes(suffix)) throw new Error(`missing audio suffix ${suffix}`)
}
if (definition.extensions.length !== definition.binaryExtensions.length) throw new Error('binary suffixes do not cover all extensions')
if (definition.loading !== 'renderer') throw new Error(`expected renderer loading, got ${definition.loading}`)
console.log('registration shape OK')

// ---------- pure helpers ----------
const cases = [
  ['dsh-resource://file/session/s1/data/data/com.termux/files/home/a%20b.mp4', '/data/data/com.termux/files/home/a b.mp4'],
  ['dsh-resource://file/absolute/data/x.mp4', '/data/x.mp4'],
  ['nope', undefined],
]
for (const [address, expected] of cases) {
  const actual = helpers.pathOfAddress(address)
  if (actual !== expected) throw new Error(`pathOfAddress(${address}) = ${actual}, expected ${expected}`)
}
console.log('pathOfAddress OK')
const url = helpers.mediaUrl('/data/data/com.termux/files/home/x.mp4')
if (url !== 'http://127.0.0.1:3080/api/file?path=%2Fdata%2Fdata%2Fcom.termux%2Ffiles%2Fhome%2Fx.mp4') throw new Error(`mediaUrl = ${url}`)
console.log('mediaUrl OK')
const rangeHeaders = new Map([['content-range', 'bytes 0-1023/1721428'], ['content-length', '1024']])
if (helpers.totalFromHeaders({ get: (name) => rangeHeaders.get(name) ?? null }) !== 1721428) throw new Error('totalFromHeaders range failed')
const lengthHeaders = new Map([['content-length', '4096']])
if (helpers.totalFromHeaders({ get: (name) => lengthHeaders.get(name) ?? null }) !== 4096) throw new Error('totalFromHeaders length failed')
console.log('totalFromHeaders OK')
if (!helpers.isAudioPath('/x/voice.mp3') || helpers.isAudioPath('/x/movie.mp4')) throw new Error('isAudioPath failed')
if (helpers.extensionOf('/x/movie.MP4') !== 'mp4') throw new Error('extensionOf failed')
console.log('suffix helpers OK')
if (helpers.humanSize(1721428) !== '1.6 MB') throw new Error(`humanSize = ${helpers.humanSize(1721428)}`)
console.log('humanSize OK')
const failure = helpers.describeMediaFailure({ target: { error: { code: 4, message: 'MEDIA_ELEMENT_ERROR: Format error' } } })
if (failure !== 'MEDIA_ERR_SRC_NOT_SUPPORTED: MEDIA_ELEMENT_ERROR: Format error') throw new Error(`describeMediaFailure = ${failure}`)
console.log('describeMediaFailure OK')

// ---------- initial render ----------
function render(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(render).join('')
  const { type, props } = node
  if (typeof type === 'function') return render(type(props))
  const attributes = []
  for (const [name, value] of Object.entries(props)) {
    if (name === 'children') continue
    if (typeof value === 'function' || value === undefined || value === null || value === false) continue
    if (name === 'style' && typeof value === 'object') {
      attributes.push(`style="${Object.entries(value).map(([key, value]) => `${key}:${value}`).join(';')}"`)
      continue
    }
    attributes.push(value === true ? name : `${name}="${String(value)}"`)
  }
  return `<${String(type)}${attributes.length ? ` ${attributes.join(' ')}` : ''}>${render(props.children)}</${String(type)}>`
}
const slotProps = slots[0].options.inject('session-1', {})
const initial = render(jsxRuntimeStub.jsx(slots[0].component, {
  resourceAddress: 'dsh-resource://file/session/session-1/data/data/com.termux/files/home/movie%20clip.mp4',
  content: {},
  t,
  ...slotProps,
}))
console.log('initial render bytes:', initial.length)
console.log('  shows loading text:', initial.includes('t:loading'))
console.log('  no <video> before the probe resolves:', !initial.includes('<video'))
console.log('  has probing marker:', initial.includes('data-media-preview="probing"'))
if (!initial.includes('t:loading')) throw new Error('loading state missing')
if (initial.includes('<video')) throw new Error('video element rendered before the probe resolves')

const bad = render(jsxRuntimeStub.jsx(slots[0].component, {
  resourceAddress: 'not-an-address',
  content: {},
  t,
  ...slotProps,
}))
console.log('bad address renders message:', bad.includes('t:badAddress'))
if (!bad.includes('t:badAddress')) throw new Error('bad address message missing')
console.log('OK')
