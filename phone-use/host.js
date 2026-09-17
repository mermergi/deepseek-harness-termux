// PhoneUse — dynamic Cordis Host plugin body.
// Backed by the Termux adb client already paired to 127.0.0.1 (uid=2000 shell,
// INJECT_EVENTS + screencap + uiautomator verified on this device).
//
// This file is the exact `code.host` body submitted to cordis_define. Keep it
// dependency-free plain JavaScript (no import/require/TS/JSX).

const KEYCODES = {
  BACK: 4, HOME: 3, APP_SWITCH: 187, MENU: 82, ENTER: 66, DEL: 67, FORWARD_DEL: 112,
  TAB: 61, ESCAPE: 111, SPACE: 62, POWER: 26, WAKEUP: 224, SLEEP: 223,
  VOLUME_UP: 24, VOLUME_DOWN: 25, MUTE: 164, PLAY_PAUSE: 85, NEXT: 87, PREVIOUS: 88,
  SEARCH: 84, CAMERA: 27, DPAD_UP: 19, DPAD_DOWN: 20, DPAD_LEFT: 21, DPAD_RIGHT: 22,
  DPAD_CENTER: 23, PAGE_UP: 92, PAGE_DOWN: 93, MOVE_HOME: 122, MOVE_END: 123,
  NOTIFICATION: 83, SETTINGS: 176, BRIGHTNESS_UP: 221, BRIGHTNESS_DOWN: 220,
  PASTE: 279, COPY: 278, CUT: 277, SELECT_ALL: 233, ASSIST: 219,
}

/** Single-quote a value for the host bash that the `shell` service runs. */
function hostQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

/** Wall-clock HH:MM:SS for a status line. */
function clock() {
  const now = new Date()
  const two = function (value) { return value < 10 ? '0' + value : String(value) }
  return two(now.getHours()) + ':' + two(now.getMinutes()) + ':' + two(now.getSeconds())
}

function clip(text, max) {
  const value = String(text)
  return value.length > max ? value.slice(0, max - 1) + '…' : value
}

function decodeEntities(text) {
  return String(text)
    .replace(/&#(\d+);/g, function (_match, digits) { return String.fromCharCode(Number(digits)) })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function shortClass(name) {
  const value = String(name)
  const dot = value.lastIndexOf('.')
  return dot === -1 ? value : value.slice(dot + 1)
}

/** Read width/height straight out of the PNG IHDR, without typed arrays. */
function pngSize(bytes) {
  if (bytes === undefined || bytes === null || bytes.length < 24) return null
  const read = function (offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  }
  return { width: read(16), height: read(20) }
}

/** One compiled attribute reader per attribute name, not one per node. */
const ATTR_PATTERNS = new Map()

function attrReader(name) {
  let pattern = ATTR_PATTERNS.get(name)
  if (pattern === undefined) {
    pattern = new RegExp('\\b' + name + '="([^"]*)"')
    ATTR_PATTERNS.set(name, pattern)
  }
  return pattern
}

/** Compact UI tree: one entry per node that a person could name or touch. */
function parseUiNodes(xml) {
  const nodes = []
  const nodePattern = /<node\b([^>]*?)\/?>/g
  let match
  while ((match = nodePattern.exec(xml)) !== null) {
    const tag = match[1]
    const attr = function (name) {
      const found = attrReader(name).exec(tag)
      return found === null ? '' : decodeEntities(found[1])
    }
    const box = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attr('bounds'))
    nodes.push({
      text: attr('text'),
      desc: attr('content-desc'),
      cls: attr('class'),
      id: attr('resource-id'),
      pkg: attr('package'),
      clickable: attr('clickable') === 'true',
      scrollable: attr('scrollable') === 'true',
      enabled: attr('enabled') !== 'false',
      bounds: box === null ? null : {
        x1: Number(box[1]), y1: Number(box[2]), x2: Number(box[3]), y2: Number(box[4]),
      },
    })
  }
  return nodes
}

function isInteresting(node) {
  if (node.bounds === null) return false
  if (node.text !== '' || node.desc !== '') return true
  if (node.clickable || node.scrollable) return true
  return /EditText/i.test(node.cls)
}

function centerOf(node) {
  return {
    x: Math.round((node.bounds.x1 + node.bounds.x2) / 2),
    y: Math.round((node.bounds.y1 + node.bounds.y2) / 2),
  }
}

function describeNode(node, index) {
  const center = centerOf(node)
  const parts = ['#' + index, 'tap=(' + center.x + ',' + center.y + ')']
  if (node.text !== '') parts.push('"' + clip(node.text, 70) + '"')
  else if (node.desc !== '') parts.push('desc="' + clip(node.desc, 70) + '"')
  parts.push('[' + shortClass(node.cls) + ']')
  if (node.id !== '') parts.push('id=' + clip(node.id, 60))
  const flags = []
  if (node.clickable) flags.push('clickable')
  if (node.scrollable) flags.push('scrollable')
  if (!node.enabled) flags.push('disabled')
  if (flags.length > 0) parts.push(flags.join(','))
  return parts.join(' ')
}

function findNodeByText(nodes, needle) {
  const lower = String(needle).toLowerCase()
  let partial = null
  for (const node of nodes) {
    if (node.bounds === null) continue
    const haystack = (node.text + '\n' + node.desc).toLowerCase()
    if (haystack.indexOf(lower) === -1) continue
    if (node.text.toLowerCase() === lower || node.desc.toLowerCase() === lower) return node
    if (partial === null) partial = node
  }
  return partial
}

function asText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function textBlocks(value) {
  return [{ type: 'text', text: asText(value) }]
}

/** Escape ASCII for `input text`: device-shell escapes, then `%s` for spaces. */
function escapeInputText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/(["'`$()<>|&;*?~#[\]{}!])/g, '\\$1')
    .replace(/ /g, '%s')
}

return {
  apply(ctx) {
    let adbPath = null
    let lastStatus = null

    /**
     * Mirror one line of run status into a single Android notification.
     *
     * While the agent drives the phone the person is looking at some other app,
     * so this is the only surface that stays visible without switching back: the
     * notification shade is a system overlay, and `--id` keeps exactly one record
     * updated in place instead of stacking a new one per step. The button returns
     * to this GUI in one tap, and the text says explicitly when a run has ended.
     *
     * Fire-and-forget on purpose: a status mirror must never fail a tool call.
     */
    function notifyStatus(text) {
      if (text === lastStatus) return
      lastStatus = text
      const command = [
        'export PATH="${PREFIX:-/data/data/com.termux/files/usr}/bin:$PATH"',
        'T="${TMPDIR:-/data/data/com.termux/files/usr/tmp}"',
        "U=$(sed -n 's|^dsh web: \\(http://127.0.0.1:[0-9]*/[^ ]*\\).*|\\1|p' \"$T/dsh_web.log\" 2>/dev/null | tail -1)",
        '[ -n "$U" ] || U="http://127.0.0.1:3080/"',
        'termux-notification --id dsh-phoneuse --alert-once -t "DSH · PhoneUse" -c ' + hostQuote(text) +
          ' --button1 "打开会话" --button1-action "termux-open-url \\"$U\\"" >/dev/null 2>&1 || true',
      ].join('; ')
      Promise.resolve(bash(command, { timeoutMs: 30000 })).catch(function () {})
    }

    // Every dispatch of a phone tool updates the status line.
    ctx.on('tools/pre-execute', function (exec, next) {
      const name = exec !== undefined && exec !== null && exec.name !== undefined ? String(exec.name) : ''
      if (name.indexOf('phone_') === 0) notifyStatus('运行中 · ' + name)
      return next()
    })

    // The run's own edge: `running` ⇄ `idle`. This is what tells a person who
    // walked away that the agent has stopped and is waiting for them.
    ctx.on('agent/status', function (payload) {
      const status = payload !== undefined && payload !== null && payload.status !== undefined ? String(payload.status) : ''
      if (status === 'idle') notifyStatus('已结束 · ' + clock() + ' · 等你指令')
      else if (status === 'running') notifyStatus('运行中…')
    })

    async function bash(command, options) {
      const shell = ctx.get('shell')
      if (shell === undefined) {
        throw new Error('PhoneUse: the host `shell` service is not mounted, so adb cannot be executed.')
      }
      const opts = options || {}
      const request = {
        command,
        timeoutMs: opts.timeoutMs === undefined ? 45000 : opts.timeoutMs,
        stdoutMaxBytes: opts.stdoutMaxBytes === undefined ? 4 * 1024 * 1024 : opts.stdoutMaxBytes,
      }
      if (opts.signal !== undefined) request.signal = opts.signal
      return await shell.run(shell.resolve(request))
    }

    async function resolveAdb() {
      if (adbPath !== null) return adbPath
      const probe = await bash('command -v adb || printf ""', { timeoutMs: 15000 })
      const found = probe.stdout.text.trim().split('\n')[0]
      if (found === '') {
        throw new Error('PhoneUse: the `adb` client is not on PATH. Install it with `pkg install android-tools`.')
      }
      adbPath = found
      return adbPath
    }

    async function adb(command, options) {
      const binary = await resolveAdb()
      return await bash(binary + ' ' + command, options)
    }

    async function adbText(command, options) {
      const result = await adb(command, options)
      if (result.exitCode !== 0) {
        const detail = (result.stderr.text || result.stdout.text || '').trim()
        throw new Error('adb ' + command.split(' ')[0] + ' failed (exit ' + result.exitCode + '): ' + clip(detail, 400))
      }
      return result.stdout.text
    }

    async function assertDevice(signal) {
      const listing = await adbText('devices', { timeoutMs: 20000, signal })
      if (!/\tdevice\b/.test(listing)) {
        throw new Error(
          'PhoneUse: no device is connected to adb, so the phone is out of reach.\n' +
          listing.trim() +
          '\nFix: enable Wireless debugging in Android settings, then reconnect this Termux adb client ' +
          '(adb pair <ip:pairPort> with the pairing code, then adb connect 127.0.0.1:<port>). ' +
          'Run phone_status to re-check.',
        )
      }
    }

    function shellCommand(inner, options) {
      return adb('shell ' + hostQuote(inner), options)
    }

    async function shellText(inner, options) {
      const result = await shellCommand(inner, options)
      if (result.exitCode !== 0 && result.stdout.text.trim() === '') {
        let devices = ''
        try {
          devices = (await adbText('devices', { timeoutMs: 15000 })).trim()
        } catch (error) {
          devices = 'adb devices failed too: ' + String(error && error.message ? error.message : error)
        }
        throw new Error(
          'adb shell failed (exit ' + result.exitCode + '): ' + clip((result.stderr.text || '').trim(), 300) +
          ' | ' + devices,
        )
      }
      return result.stdout.text
    }

    /**
     * One `adb shell` round trip for the whole screen read: dump the tree to the
     * device, then emit the focus line and the XML together. Fewer child
     * processes under the app, and an explicit stdout budget so a large
     * hierarchy cannot be silently truncated at the pipe.
     */
    async function dumpScreen(signal) {
      const command = [
        'timeout 25 uiautomator dump /sdcard/phoneuse-ui.xml >/dev/null 2>&1',
        "printf 'FOCUS='",
        "dumpsys window | grep -m1 -o 'mCurrentFocus=[^}]*}' || true",
        "printf '\\n<<UI>>\\n'",
        'cat /sdcard/phoneuse-ui.xml',
      ].join('; ')
      const out = await shellText(command, { timeoutMs: 60000, signal, stdoutMaxBytes: 8 * 1024 * 1024 })
      const marker = out.indexOf('<<UI>>')
      if (marker === -1 || out.indexOf('<hierarchy', marker) === -1) {
        throw new Error('PhoneUse: uiautomator produced no hierarchy (screen off, secure screen, or the dump timed out). Call phone_status, then retry once.')
      }
      const focus = /FOCUS=([^\n]*)/.exec(out.slice(0, marker))
      return {
        nodes: parseUiNodes(out.slice(marker)),
        focus: focus === null || focus[1].trim() === '' ? 'unknown' : focus[1].replace('mCurrentFocus=', '').trim(),
      }
    }

    async function foregroundApp(signal) {
      const text = await shellText(
        'dumpsys window | grep -m1 -o "mCurrentFocus=[^}]*}" || true',
        { timeoutMs: 30000, signal },
      )
      const line = text.trim()
      return line === '' ? 'unknown' : line.replace('mCurrentFocus=', '')
    }

    harness.registerTool(ctx, harness.defineTool({
      name: 'phone_status',
      description: 'Report whether this Android phone is reachable through adb, plus model, screen size, screen wake state, and the foreground app. Call it first, and after any phone_* failure, to tell "the phone is unreachable" apart from "the action failed".',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_args, value) => textBlocks(value) },
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const listing = await adbText('devices', { timeoutMs: 20000, signal: exec.signal })
        if (!/\tdevice\b/.test(listing)) {
          return {
            connected: false,
            adb_devices: listing.trim(),
            hint: 'Enable Wireless debugging, then `adb pair` + `adb connect 127.0.0.1:<port>` from Termux.',
          }
        }
        const probe = [
          'echo "MODEL=$(getprop ro.product.model)"',
          'echo "RELEASE=$(getprop ro.build.version.release)"',
          'echo "SIZE=$(wm size | tr -d \'\\r\' | tail -1)"',
          'echo "DENSITY=$(wm density | tr -d \'\\r\' | tail -1)"',
          'echo "WAKE=$(dumpsys power | grep -m1 -o \'mWakefulness=[A-Za-z]*\')"',
          'echo "FOCUS=$(dumpsys window | grep -m1 -o \'mCurrentFocus=[^}]*}\')"',
        ].join('; ')
        const out = await shellText(probe, { timeoutMs: 40000, signal: exec.signal })
        const fields = {}
        for (const line of out.split('\n')) {
          const at = line.indexOf('=')
          if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim()
        }
        return {
          connected: true,
          model: fields.MODEL === undefined ? 'unknown' : fields.MODEL,
          android_release: fields.RELEASE === undefined ? 'unknown' : fields.RELEASE,
          screen: fields.SIZE === undefined ? 'unknown' : fields.SIZE.replace('Physical size: ', ''),
          density: fields.DENSITY === undefined ? 'unknown' : fields.DENSITY.replace('Physical density: ', ''),
          screen_state: fields.WAKE === undefined ? 'unknown' : fields.WAKE.replace('mWakefulness=', ''),
          foreground: fields.FOCUS === undefined ? 'unknown' : fields.FOCUS.replace('mCurrentFocus=', ''),
        }
      },
    }))

    harness.registerTool(ctx, harness.defineTool({
      name: 'phone_screenshot',
      description: 'Capture the phone screen and return it as an image you can actually look at. Coordinates measured on the returned image are NOT reliable for tapping — use phone_ui for real device-pixel coordinates. Use this to understand layout, colors, and state; use phone_ui to locate something to touch.',
      parameters: {
        max_width: {
          type: 'integer',
          description: 'Downscale the capture to at most this pixel width before attaching it (default 720, 0 = native resolution). Smaller is cheaper and usually still readable.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            device_screen: { type: 'string', required: true },
            image_width: { type: 'integer', required: true },
            image_height: { type: 'integer', required: true },
            captured_bytes: { type: 'integer', required: true },
            image: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                attachmentId: { type: 'string', required: true },
                mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
                bytes: { type: 'integer', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: '<phone_screenshot>\n<file>' + value.path + '</file>\n<device_screen>' + value.device_screen +
            '</device_screen>\n<image>' + value.image_width + 'x' + value.image_height +
            ' px</image>\n<note>The attached image may be downscaled further by the harness. Never derive tap coordinates from it — call phone_ui and tap the reported tap=(x,y).</note>\n</phone_screenshot>',
        }, {
          type: 'image',
          attachment: {
            attachmentId: value.image.attachmentId,
            mediaType: value.image.mediaType,
            bytes: value.image.bytes,
            width: value.image.width,
            height: value.image.height,
          },
        }],
      },
      async execute(args, exec) {
        await assertDevice(exec.signal)
        const fs = ctx.get('fs')
        const attachments = ctx.get('attachments')
        if (fs === undefined) throw new Error('PhoneUse: no filesystem service is mounted.')
        if (attachments === undefined) throw new Error('PhoneUse: no attachment service is mounted, so the capture cannot reach the model as an image.')

        const width = args.max_width === undefined || args.max_width === null ? 720 : Number(args.max_width)
        const stamp = String(Date.now())
        const command = [
          'mkdir -p "$TMPDIR/phoneuse"',
          'out="$TMPDIR/phoneuse/screen-' + stamp + '.png"',
          'adb exec-out screencap -p > "$out"',
          'if [ ! -s "$out" ]; then printf "EMPTY"; exit 1; fi',
          width > 0
            ? 'if command -v ffmpeg >/dev/null 2>&1; then small="$TMPDIR/phoneuse/screen-' + stamp + '-w' + width +
              '.png"; if ffmpeg -y -loglevel error -i "$out" -vf scale=' + width + ':-2 "$small" 2>/dev/null; then out="$small"; fi; fi'
            : 'true',
          'printf "%s %s" "$out" "$(wc -c < "$out" | tr -d " ")"',
        ].join('; ')
        const captured = await bash(command, { timeoutMs: 60000, signal: exec.signal })
        const text = captured.stdout.text.trim()
        if (captured.exitCode !== 0 || text.indexOf(' ') === -1) {
          throw new Error('PhoneUse: screencap produced no image. ' + clip((captured.stderr.text || text).trim(), 300))
        }
        const space = text.lastIndexOf(' ')
        const file = text.slice(0, space)
        const size = Number(text.slice(space + 1))

        const target = await fs.resolve(file, { signal: exec.signal })
        const bytes = await fs.readBytes(target, exec.signal, 64 * 1024 * 1024)
        const ref = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'phone-screen.png' })
        const screen = await shellText('wm size | tr -d \'\\r\' | tail -1', { timeoutMs: 20000, signal: exec.signal })
        const measured = pngSize(bytes)
        const width2 = measured === null ? Number(ref.width) : measured.width
        const height2 = measured === null ? Number(ref.height) : measured.height
        return {
          path: file,
          device_screen: screen.trim().replace('Physical size: ', ''),
          image_width: width2,
          image_height: height2,
          captured_bytes: size,
          image: {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: Number(ref.width),
            height: Number(ref.height),
          },
        }
      },
    }))

    harness.registerTool(ctx, harness.defineTool({
      name: 'phone_ui',
      description: 'Dump the accessibility tree of the current screen as a compact, numbered list of named or touchable elements with their REAL device-pixel tap coordinates, class, resource id, and flags (clickable/scrollable/disabled). This is the authoritative source for coordinates: read it, then phone_tap the printed tap=(x,y).',
      parameters: {
        filter: { type: 'string', description: 'Only list elements whose text or content description contains this substring (case-insensitive).' },
        limit: { type: 'integer', description: 'Maximum listed elements (default 60, max 400).' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => textBlocks(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const screen = await dumpScreen(exec.signal)
        const nodes = screen.nodes
        const filter = args.filter === undefined || args.filter === null ? '' : String(args.filter).toLowerCase()
        let listed = 0
        const lines = []
        for (const node of nodes) {
          if (!isInteresting(node)) continue
          if (filter !== '') {
            const haystack = (node.text + '\n' + node.desc).toLowerCase()
            if (haystack.indexOf(filter) === -1) continue
          }
          listed += 1
          if (lines.length < (args.limit === undefined || args.limit === null ? 60 : Math.min(Number(args.limit), 400))) {
            lines.push(describeNode(node, listed))
          }
        }
        const foreground = screen.focus
        const head = 'foreground: ' + foreground + '\n' +
          (filter === '' ? '' : 'filter: "' + filter + '"\n') +
          'elements: ' + listed + (lines.length < listed ? ' (showing first ' + lines.length + ')' : '') + '\n' +
          caution +
          'coordinates are real device pixels — tap them with phone_tap\n'
        return head + (lines.length === 0 ? '(no matching element)' : lines.join('\n'))
      },
    }))

    harness.registerTool(ctx, harness.defineTool({
      name: 'phone_tap',
      description: 'Tap a point on the phone screen. Give x and y in device pixels (from phone_ui), or give text to tap the first element whose text/content description contains that string. Set duration_ms above ~400 for a long press.',
      parameters: {
        x: { type: 'integer', description: 'Device-pixel x coordinate.' },
        y: { type: 'integer', description: 'Device-pixel y coordinate.' },
        text: { type: 'string', description: 'Instead of x/y: tap the first element whose text or content description contains this string.' },
        duration_ms: { type: 'integer', description: 'Press duration in milliseconds; above ~400 this becomes a long press (default 60).' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => textBlocks(value) },
      async execute(args, exec) {
        await assertDevice(exec.signal)
        let x = args.x === undefined || args.x === null ? null : Number(args.x)
        let y = args.y === undefined || args.y === null ? null : Number(args.y)
        let via = 'coordinates'
        if ((x === null || y === null) && args.text !== undefined && args.text !== null) {
          const node = findNodeByText((await dumpScreen(exec.signal)).nodes, String(args.text))
          if (node === null) throw new Error('PhoneUse: no element on screen matches "' + String(args.text) + '". Call phone_ui to list what is actually there.')
          const center = centerOf(node)
          x = center.x
          y = center.y
          via = 'text "' + String(args.text) + '" → ' + shortClass(node.cls)
        }
        if (x === null || y === null) throw new Error('PhoneUse: phone_tap needs either x/y or text.')

        const duration = args.duration_ms === undefined || args.duration_ms === null ? 60 : Number(args.duration_ms)
        const inner = duration > 400
          ? 'input swipe ' + x + ' ' + y + ' ' + x + ' ' + y + ' ' + duration
          : 'input tap ' + x + ' ' + y
        await shellText(inner, { timeoutMs: 30000, signal: exec.signal })
        return { ok: true, tapped: { x, y }, via, duration_ms: duration }
      },
    }))

    harness.registerTool(ctx, harness.defineTool({
      name: 'phone_swipe',
      description: 'Swipe or fling on the phone screen between two device-pixel points. Use it to scroll lists, dismiss notifications, or move a slider. duration_ms controls the gesture speed (shorter = faster fling).',
      parameters: {
        x1: { type: 'integer', required: true, description: 'Start x in device pixels.' },
        y1: { type: 'integer', required: true, description: 'Start y in device pixels.' },
        x2: { type: 'integer', required: true, description: 'End x in device pixels.' },
        y2: { type: 'integer', required: true, description: 'End y in device pixels.' },
        duration_ms: { type: 'integer', description: 'Gesture duration in milliseconds (default 300).' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => textBlocks(value) },
      async execute(args, exec) {
        await assertDevice(exec.signal)
        const duration = args.duration_ms === undefined || args.duration_ms === null ? 300 : Number(args.duration_ms)
        await shellText(
          'input swipe ' + Number(args.x1) + ' ' + Number(args.y1) + ' ' + Number(args.x2) + ' ' + Number(args.y2) + ' ' + duration,
          { timeoutMs: 30000, signal: exec.signal },
        )
        return { ok: true, swiped: [Number(args.x1), Number(args.y1), Number(args.x2), Number(args.y2)], duration_ms: duration }
      },
    }))

    harness.registerTool(ctx, harness.defineTool({
      name: 'phone_key',
      description: 'Send one Android key event by name — BACK, HOME, APP_SWITCH, ENTER, DEL, TAB, POWER, WAKEUP, SLEEP, VOLUME_UP/DOWN, DPAD_*, PAGE_UP/DOWN, SEARCH, NOTIFICATION, SETTINGS, PASTE, COPY, CUT, SELECT_ALL. Prefer BACK over HOME to leave a screen without losing the task.',
      parameters: {
        key: { type: 'string', required: true, description: 'Key name from the documented set (case-insensitive), or a raw numeric keycode.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => textBlocks(value) },
      async execute(args, exec) {
        await assertDevice(exec.signal)
        const raw = String(args.key).trim()
        const named = KEYCODES[raw.toUpperCase()]
        const code = named === undefined ? (/^\d+$/.test(raw) ? Number(raw) : null) : named
        if (code === null) {
          throw new Error('PhoneUse: unknown key "' + raw + '". Known names: ' + Object.keys(KEYCODES).join(', ') + ' — or pass a numeric keycode.')
        }
        await shellText('input keyevent ' + code, { timeoutMs: 30000, signal: exec.signal })
        return { ok: true, key: raw.toUpperCase(), keycode: code }
      },
    }))


    harness.registerTool(ctx, harness.defineTool({
      name: 'phone_text',
      description: 'Type text into the focused field. ASCII goes through `input text`; non-ASCII (e.g. Chinese) is delivered by setting the device clipboard and sending PASTE, which needs the Termux:API app. Tap the field first so it has focus.',
      parameters: {
        text: { type: 'string', required: true, description: 'The text to type. Use \\n for a newline only if the field accepts ENTER separately.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => textBlocks(value) },
      async execute(args, exec) {
        await assertDevice(exec.signal)
        const text = String(args.text)
        if (/^[\x20-\x7E]*$/.test(text)) {
          await shellText('input text ' + hostQuote(escapeInputText(text)), { timeoutMs: 30000, signal: exec.signal })
          return { ok: true, typed: text, route: 'input text', note: 'Verify with phone_ui.' }
        }
        const api = await bash('command -v termux-clipboard-set || printf ""', { timeoutMs: 15000, signal: exec.signal })
        if (api.stdout.text.trim() === '') {
          throw new Error('PhoneUse: this text is not ASCII, and `input text` cannot type it. Install the Termux:API app (provides termux-clipboard-set) so PhoneUse can paste non-ASCII text, or type it with phone_key/ASCII only.')
        }
        const copied = await bash('termux-clipboard-set ' + hostQuote(text), { timeoutMs: 20000, signal: exec.signal })
        if (copied.exitCode !== 0) {
          throw new Error('PhoneUse: termux-clipboard-set failed: ' + clip((copied.stderr.text || copied.stdout.text).trim(), 200) + ' (is the Termux:API app installed and is the field focused?)')
        }
        await shellText('input keyevent 279', { timeoutMs: 30000, signal: exec.signal })
        return { ok: true, typed: text, route: 'clipboard + PASTE', note: 'Verify with phone_ui.' }
      },
    }))

    harness.registerTool(ctx, harness.defineTool({
      name: 'phone_app',
      description: 'Inspect or control apps: action=current reads the foreground app, action=list lists installed packages (third-party by default, `filter` narrows it), action=start launches a package or opens a URL, action=stop force-stops a package.',
      parameters: {
        action: { type: 'string', required: true, enum: ['current', 'list', 'start', 'stop'], description: 'What to do.' },
        target: { type: 'string', description: 'For start/stop: a package name (com.android.settings) or, for start, an http(s) URL.' },
        filter: { type: 'string', description: 'For list: only packages whose name contains this substring.' },
        all: { type: 'boolean', description: 'For list: include system packages (default false).' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => textBlocks(value) },
      async execute(args, exec) {
        await assertDevice(exec.signal)
        const action = String(args.action)
        if (action === 'current') {
          return { action, foreground: await foregroundApp(exec.signal) }
        }
        const filter = args.filter === undefined || args.filter === null ? '' : String(args.filter)
        if (action === 'list') {
          const out = await shellText('pm list packages ' + (args.all === true ? '' : '-3 '), { timeoutMs: 40000, signal: exec.signal })
          let packages = out.split('\n').map((line) => line.replace('package:', '').trim()).filter((line) => line !== '')
          if (filter !== '') packages = packages.filter((name) => name.indexOf(filter) !== -1)
          return { action, filter, count: packages.length, packages: packages.slice(0, 100), truncated: packages.length > 100 }
        }
        const target = args.target === undefined || args.target === null ? '' : String(args.target).trim()
        if (target === '') throw new Error('PhoneUse: action "' + action + '" needs `target`.')
        if (action === 'stop') {
          await shellText('am force-stop ' + hostQuote(target), { timeoutMs: 30000, signal: exec.signal })
          return { action, package: target, ok: true }
        }
        if (action === 'start') {
          if (/^(https?|market|tel|mailto):/i.test(target)) {
            await shellText('am start -a android.intent.action.VIEW -d ' + hostQuote(target), { timeoutMs: 40000, signal: exec.signal })
            return { action, url: target, ok: true }
          }
          const out = await shellText(
            'monkey -p ' + hostQuote(target) + ' -c android.intent.category.LAUNCHER 1 2>&1 | tail -3',
            { timeoutMs: 40000, signal: exec.signal },
          )
          if (/No activities found|aborted/i.test(out)) {
            throw new Error('PhoneUse: could not launch "' + target + '" — no launcher activity. Check the package name with phone_app action=list.')
          }
          return { action, package: target, ok: true, detail: clip(out.trim(), 200) }
        }
        throw new Error('PhoneUse: unknown action "' + action + '".')
      },
    }))
  },
}
