// Exercise the browser half of @local/dsh-video-preview without a browser:
// capture the module registration, run apply() against a stub client context, and
// render the body component through a tiny JSX serializer. (react is prebundled into
// the client shell, so there is no node package to import here.)
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

const bundleClient = new URL('./lib/client.js', import.meta.url)
await import(bundleClient.href)
if (registrations.length !== 1) throw new Error(`expected one registration, got ${registrations.length}`)
const registration = registrations[0]
console.log('module id:', registration.id)

// Minimal React surface: enough for a single render pass of MediaBody.
let hookIndex = 0
const reactStub = {
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    hookIndex += 1
    return [value, () => {}]
  },
  useMemo(factory) {
    hookIndex += 1
    return factory()
  },
  useCallback(fn) {
    hookIndex += 1
    return fn
  },
  useEffect() {
    hookIndex += 1
  },
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } }
  },
  Fragment: Symbol('Fragment'),
}
const Fragment = reactStub.Fragment
function jsx(type, props) {
  return { type, props: props ?? {} }
}
function jsxs(type, props) {
  return jsx(type, props)
}
const jsxRuntimeStub = { jsx, jsxs, Fragment }

const shimRequire = (specifier) => {
  if (specifier === 'react') return reactStub
  if (specifier === 'react/jsx-runtime') return jsxRuntimeStub
  throw new Error(`unexpected require: ${specifier}`)
}
const exportsObject = registration.factory(shimRequire)
console.log('exports:', Object.keys(exportsObject).join(', '))

const previews = []
const slots = []
let localeRegistrations = 0
const t = (key) => `t:${key}`
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
const component = slots[0].component
const slotProps = slots[0].options.inject('session-1', {})
console.log('injected props:', Object.keys(slotProps).join(', '))

/** Serialize a plain JSX tree to HTML-ish text, skipping functions. */
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
      attributes.push(`style="${Object.entries(value).map(([k, v]) => `${k}:${v}`).join(';')}"`)
      continue
    }
    if (value === true) attributes.push(name)
    else attributes.push(`${name}="${String(value)}"`)
  }
  return `<${String(type)}${attributes.length ? ` ${attributes.join(' ')}` : ''}>${render(props.children)}</${String(type)}>`
}

hookIndex = 0
const videoHtml = render(
  jsx(component, {
    resourceAddress: 'dsh-resource://file/session/session-1/data/data/com.termux/files/home/movie%20clip.mp4',
    content: {},
    t,
    ...slotProps,
  }),
)
console.log('video render bytes:', videoHtml.length)
console.log('  has <video>:', videoHtml.includes('<video'))
console.log('  has controls:', /<video[^>]*controls/.test(videoHtml))
console.log('  has playsinline:', /<video[^>]*playsInline/.test(videoHtml))
console.log('  has api/file src:', videoHtml.includes('/api/file?path='))
console.log('  src:', /src="([^"]+)"/.exec(videoHtml)?.[1])

hookIndex = 0
const audioHtml = render(
  jsx(component, {
    resourceAddress: 'dsh-resource://file/session/session-1/data/data/com.termux/files/home/voice.mp3',
    content: {},
    t,
    ...slotProps,
  }),
)
console.log('audio render has <audio>:', audioHtml.includes('<audio'))

hookIndex = 0
const badHtml = render(jsx(component, { resourceAddress: 'not-an-address', content: {}, t, ...slotProps }))
console.log('bad address renders message:', badHtml.includes('t:badAddress'))

const definitions = previews[0] ?? {}
const videoExtensions = ['mp4', 'webm', 'mov', 'm4v', 'mkv']
const audioExtensions = ['mp3', 'wav', 'm4a', 'flac']
console.log(
  '  declares every video suffix:',
  videoExtensions.every((suffix) => definitions.extensions.includes(suffix)),
)
console.log(
  '  declares every audio suffix:',
  audioExtensions.every((suffix) => definitions.extensions.includes(suffix)),
)
console.log(
  '  binary suffixes cover all extensions:',
  definitions.extensions.length === definitions.binaryExtensions.length,
)
console.log('OK')
