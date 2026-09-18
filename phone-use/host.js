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
      if (name.indexOf('phone_') === 0) {
        notifyStatus('运行中 · ' + name)
        startAppIndexWarmPass()
      }
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

    /**
     * Find the wireless-debugging port again and reconnect.
     *
     * The adb link is the one thing that does not persist: Android re-rolls the
     * port whenever wireless debugging is toggled or the device reboots, so
     * yesterday's `adb connect 127.0.0.1:<port>` is dead. The daemon does listen
     * on loopback, so the port is discoverable from Termux itself: blocking
     * connects across the standard range with a 50 ms timeout, in a thread pool.
     *
     * The obvious-looking alternative — non-blocking connect + select in batches —
     * is wrong here: it reported no listener at all while adb was demonstrably
     * connected to one. (Technique taken from the `ui` script in
     * ~/automation-attic, which is where it was first made to work.)
     */
    async function reconnect(signal) {
      const scan = "python3 - <<'PY'\n" + [
        'import socket',
        'from concurrent.futures import ThreadPoolExecutor',
        'def probe(p):',
        '    s = socket.socket(); s.settimeout(0.05)',
        '    try:',
        '        s.connect(("127.0.0.1", p)); return p',
        '    except OSError:',
        '        return None',
        '    finally:',
        '        s.close()',
        'with ThreadPoolExecutor(max_workers=600) as ex:',
        '    print(" ".join(str(r) for r in ex.map(probe, range(30000, 50000)) if r))',
      ].join('\n') + '\nPY'
      const scanned = await bash(scan, { timeoutMs: 120000, signal })
      const ports = scanned.stdout.text.trim().split(/\s+/).filter((value) => /^[0-9]+$/.test(value))
      for (const port of ports) {
        await adb('connect 127.0.0.1:' + port, { timeoutMs: 20000, signal })
        const state = await adb('get-state', { timeoutMs: 20000, signal })
        if (state.exitCode === 0 && state.stdout.text.trim() === 'device') {
          return { port, ports }
        }
        await adb('disconnect 127.0.0.1:' + port, { timeoutMs: 20000, signal })
      }
      return { port: null, ports }
    }

    /**
     * Hard dependency for every action tool: a live device, reconnecting once by
     * itself when the link dropped. Returns how it was found so a caller can say
     * so out loud instead of silently succeeding on a link the user thinks is down.
     */
    async function assertDevice(signal) {
      let listing = await adbText('devices', { timeoutMs: 20000, signal })
      if (/\tdevice\b/.test(listing)) return { recovered: null }

      const attempt = await reconnect(signal)
      listing = await adbText('devices', { timeoutMs: 20000, signal })
      if (/\tdevice\b/.test(listing)) return { recovered: attempt.port }

      const why = attempt.ports.length === 0
        ? 'its own port scan found no listener on 127.0.0.1:30000-49999, which normally means Wireless debugging is off'
        : 'its own port scan found ' + attempt.ports.join(', ') + ', but adb connect did not take'
      throw new Error(
        'PhoneUse: no device is connected to adb, so the phone is out of reach.\n' + listing.trim() +
        '\nPhoneUse already tried to reconnect by itself: ' + why + '.' +
        '\nFix: open 开发者选项 → 无线调试, then call phone_status again — the port is found automatically.',
      )
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

    // ── installed-app index: display name ⇄ package ──────────────────────────
    //
    // `pm list packages` knows package names and nothing else, so "打开微信" has
    // no answer in it: com.tencent.mm is not guessable from the display name. The
    // name only exists inside each APK's resource table, and Termux ships aapt2,
    // so this index is built by reading every installed APK's badging once and
    // caching it at ~/.cache/dsh-phone-use/apps.json. A refresh re-reads only the
    // APKs whose size/mtime moved, so installs and updates cost one badging each.
    //
    // Measured on this phone (8-way parallel, 489 packages incl. system): ~21 s
    // cold, <1 s warm. The warm pass therefore runs detached, started by the
    // first phone_* call of a session, and a name lookup only pays for a scan
    // when the cache is cold and that pass has not landed yet.
    const APP_INDEX_TTL_MS = 5 * 60 * 1000
    const APP_SCAN_PARALLEL = 8
    const APP_SCAN_BUDGET_S = 40
    const APP_CACHE_SH = 'H="${HOME:-/data/data/com.termux/files/home}"; D="$H/.cache/dsh-phone-use"'

    // MIUI keeps the Chinese names of its own apps in separate RRO overlays, so
    // the base APK of Settings only ever says "Settings". These are the names
    // people actually use for the stock apps; a miss falls through to APK labels.
    // Names people say that no APK contains, in two groups:
    //  - MIUI/HyperOS stock apps: their Chinese strings ship in RRO overlays, so
    //    the base APK label is only "Notes"/"Clock"/"Settings";
    //  - brands whose APK label is English or pinyin: the APK says "X" (推特),
    //    "WeCom" (企业微信), "DingDing" (钉钉), "Meituan" (美团).
    // `phone_app action=alias` adds to this at runtime and always wins over it.
    const APP_ALIASES = {
      '设置': 'com.android.settings', 'settings': 'com.android.settings',
      '相机': 'com.android.camera', 'camera': 'com.android.camera',
      '相册': 'com.miui.gallery', 'gallery': 'com.miui.gallery',
      '时钟': 'com.android.deskclock', '闹钟': 'com.android.deskclock', 'clock': 'com.android.deskclock',
      '日历': 'com.android.calendar', 'calendar': 'com.android.calendar',
      '计算器': 'com.miui.calculator', 'calculator': 'com.miui.calculator',
      '联系人': 'com.android.contacts', '通讯录': 'com.android.contacts', 'contacts': 'com.android.contacts',
      '电话': 'com.android.dialer', '拨号': 'com.android.dialer', 'dialer': 'com.android.dialer',
      '信息': 'com.android.mms', '短信': 'com.android.mms', 'messages': 'com.android.mms',
      '文件管理': 'com.android.fileexplorer', '文件': 'com.android.fileexplorer', 'filemanager': 'com.android.fileexplorer',
      '浏览器': 'com.android.browser', 'browser': 'com.android.browser',
      '音乐': 'com.miui.player', 'music': 'com.miui.player',
      '天气': 'com.miui.weather2', 'weather': 'com.miui.weather2',
      '录音机': 'com.android.soundrecorder', 'recorder': 'com.android.soundrecorder',
      '应用商店': 'com.xiaomi.market', '小米应用商店': 'com.xiaomi.market', 'store': 'com.xiaomi.market',
      '安全中心': 'com.miui.securitycenter', 'security': 'com.miui.securitycenter',
      '主题壁纸': 'com.android.thememanager', 'themes': 'com.android.thememanager',
      '笔记': 'com.miui.notes', 'notes': 'com.miui.notes',
      '邮件': 'com.android.email', 'mail': 'com.android.email',
      '指南针': 'com.miui.compass', 'compass': 'com.miui.compass',
      '扫一扫': 'com.xiaomi.scanner', 'scanner': 'com.xiaomi.scanner',
      '小米视频': 'com.miui.video', '视频': 'com.miui.video',
      '屏幕录制': 'com.miui.screenrecorder', '录屏': 'com.miui.screenrecorder',
      '下载管理': 'com.android.providers.downloads.ui', 'downloads': 'com.android.providers.downloads.ui',
      '钱包': 'com.mipay.wallet', 'wallet': 'com.mipay.wallet',
      '万能遥控': 'com.duokan.phone.remotecontroller', '遥控': 'com.duokan.phone.remotecontroller',
      '小米云盘': 'com.miui.newmidrive', '云盘': 'com.miui.newmidrive',
      '垃圾清理': 'com.miui.cleanmaster', '清理': 'com.miui.cleanmaster', 'cleaner': 'com.miui.cleanmaster',
      '小米画报': 'com.mfashiongallery.emag', '画报': 'com.mfashiongallery.emag',
      '小米耳机': 'com.mi.earphone', 'earbuds': 'com.mi.earphone',
      '小爱同学': 'com.miui.voiceassistProxy', '小爱': 'com.miui.voiceassistProxy',
      '服务与反馈': 'com.miui.miservice', '小米服务': 'com.miui.miservice',
      '推特': 'com.twitter.android', 'twitter': 'com.twitter.android',
      '油管': 'com.google.android.youtube', 'youtube': 'com.google.android.youtube',
      '谷歌浏览器': 'com.android.chrome', 'chrome': 'com.android.chrome',
      '谷歌邮箱': 'com.google.android.gm', 'gmail': 'com.google.android.gm',
      '谷歌': 'com.google.android.googlequicksearchbox', 'google': 'com.google.android.googlequicksearchbox',
      '谷歌商店': 'com.android.vending', 'play商店': 'com.android.vending',
      '企业微信': 'com.tencent.wework', 'wecom': 'com.tencent.wework',
      '钉钉': 'com.alibaba.android.rimet', 'dingtalk': 'com.alibaba.android.rimet', 'dingding': 'com.alibaba.android.rimet',
      '美团': 'com.sankuai.meituan', 'meituan': 'com.sankuai.meituan',
      '大众点评': 'com.dianping.v1', '点评': 'com.dianping.v1', 'dianping': 'com.dianping.v1',
      '微博': 'com.sina.weibo', 'weibo': 'com.sina.weibo',
      '云闪付': 'com.unionpay', 'unionpay': 'com.unionpay',
      '哔哩哔哩': 'tv.danmaku.bili', 'b站': 'tv.danmaku.bili', 'bilibili': 'tv.danmaku.bili',
      '抖音': 'com.ss.android.ugc.aweme', 'douyin': 'com.ss.android.ugc.aweme',
      '剪映': 'com.lemon.lv', 'capcut': 'com.lemon.lv',
      '腾讯会议': 'com.tencent.wemeet.app', 'wemeet': 'com.tencent.wemeet.app',
      '滴滴': 'com.sdu.didi.psnger', 'didi': 'com.sdu.didi.psnger',
      '网易云': 'com.netease.cloudmusic', '网易云音乐': 'com.netease.cloudmusic',
      '铁路12306': 'com.MobileTicket', '12306': 'com.MobileTicket',
      '支付宝': 'com.eg.android.AlipayGphone', 'alipay': 'com.eg.android.AlipayGphone',
      '微信': 'com.tencent.mm', 'wechat': 'com.tencent.mm',
      '淘宝': 'com.taobao.taobao', 'taobao': 'com.taobao.taobao',
      '京东': 'com.jingdong.app.mall', 'jd': 'com.jingdong.app.mall',
      '拼多多': 'com.xunmeng.pinduoduo', 'pdd': 'com.xunmeng.pinduoduo',
      '闲鱼': 'com.taobao.idlefish',
      '高德地图': 'com.autonavi.minimap', '高德': 'com.autonavi.minimap',
      '百度网盘': 'com.baidu.netdisk', '迅雷': 'com.xunlei.downloadprovider', '夸克': 'com.quark.browser',
      '学习通': 'com.chaoxing.mobile', '超星': 'com.chaoxing.mobile',
      'wps': 'cn.wps.moffice_eng', 'boss直聘': 'com.hpbr.bosszhipin',
      '千问': 'com.aliyun.tongyi', '通义千问': 'com.aliyun.tongyi', '豆包': 'com.larus.nova',
      'deepseek': 'com.deepseek.chat', 'chatgpt': 'com.openai.chatgpt', 'gpt': 'com.openai.chatgpt',
      '阅读': 'io.legado.app.release', 'legado': 'io.legado.app.release',
      'p站': 'jp.pxv.android', 'pixiv': 'jp.pxv.android',
      '王者荣耀': 'com.tencent.tmgp.sgame', '王者': 'com.tencent.tmgp.sgame',
      '小米商城': 'com.xiaomi.shop', '小米社区': 'com.xiaomi.vipaccount', '小米游戏中心': 'com.xiaomi.gamecenter',
      '讯飞输入法': 'com.iflytek.inputmethod', '百度输入法': 'com.baidu.input_mi',
      'taptap': 'com.taptap', 'termux': 'com.termux', 'shizuku': 'moe.shizuku.privileged.api',
      'qq音乐': 'com.tencent.qqmusic', 'qq邮箱': 'com.tencent.androidqqmail',
      '优酷': 'com.youku.phone', '爱奇艺': 'com.qiyi.video', '腾讯视频': 'com.tencent.qqlive',
      '快手': 'com.smile.gifmaker', '小红书': 'com.xingin.xhs', '知乎': 'com.zhihu.android',
      'tiktok': 'com.zhiliaoapp.musically',
      'mt管理器': 'bin.mt.plus', '杀戮尖塔': 'com.humble.SlayTheSpire',
      '学堂在线': 'com.xuetangx.mobile', '深信服': 'com.sangfor.vpn.client.phone',
      '天翼': 'com.ct.client', '网易大神': 'com.netease.gl',
      '相册编辑': 'com.miui.mediaeditor', '图片编辑': 'com.miui.mediaeditor',
      '全球上网': 'com.miui.virtualsim', 'termux api': 'com.termux.api',
    }

    /** Case- and separator-insensitive form, used by every name comparison. */
    function normalizeName(value) {
      return String(value).trim().toLowerCase().replace(/[\s_\-·.]+/g, '')
    }

    // ── spoken-name aliases: the curated table plus everything learned ────────
    let aliasCache = null

    async function loadAliases(signal) {
      if (aliasCache !== null) return aliasCache
      const read = await bash(APP_CACHE_SH + '; cat "$D/aliases.json" 2>/dev/null || true', { timeoutMs: 20000, signal, stdoutMaxBytes: 1024 * 1024 })
      const learned = {}
      try {
        const parsed = JSON.parse(read.stdout.text)
        if (parsed !== null && typeof parsed === 'object') {
          for (const key of Object.keys(parsed)) {
            if (typeof parsed[key] === 'string' && parsed[key] !== '') learned[normalizeName(key)] = parsed[key]
          }
        }
      } catch (error) {
        // nothing learned yet
      }
      const curated = {}
      for (const key of Object.keys(APP_ALIASES)) curated[normalizeName(key)] = APP_ALIASES[key]
      aliasCache = { learned, curated }
      return aliasCache
    }

    /** Learned names win over the curated table: Map(normalized name -> package). */
    async function aliasMap(signal) {
      const aliases = await loadAliases(signal)
      const byName = new Map()
      for (const key of Object.keys(aliases.curated)) byName.set(key, aliases.curated[key])
      for (const key of Object.keys(aliases.learned)) byName.set(key, aliases.learned[key])
      return byName
    }

    async function saveAlias(name, pkg, signal) {
      const aliases = await loadAliases(signal)
      const learned = Object.assign({}, aliases.learned)
      learned[normalizeName(name)] = pkg
      const out = await bash(
        APP_CACHE_SH + '; mkdir -p "$D"; printf %s ' + hostQuote(JSON.stringify(learned)) +
          ' > "$D/aliases.json.tmp" && mv "$D/aliases.json.tmp" "$D/aliases.json"',
        { timeoutMs: 20000, signal },
      )
      if (out.exitCode !== 0) throw new Error('PhoneUse: could not save the alias: ' + clip(out.stderr.text.trim(), 160))
      aliasCache = null
      return learned
    }

    /** Parse a "pkg<TAB>label<TAB>zh|zh" scan into a Map. */
    function parseLabelRows(text) {
      const rows = new Map()
      for (const line of String(text).split('\n')) {
        const parts = line.split('\t')
        if (parts.length < 2) continue
        const pkg = parts[0].trim()
        if (pkg === '') continue
        rows.set(pkg, {
          label: (parts[1] === undefined ? '' : parts[1]).trim(),
          zh: (parts[2] === undefined ? '' : parts[2]).trim(),
        })
      }
      return rows
    }

    function mergeIndexEntry(index, row, hit) {
      index.entries[row.pkg] = { label: hit.label, zh: hit.zh, apk: row.apk, size: row.size, mtime: row.mtime }
    }

    async function loadAppIndex(signal) {
      const empty = { generatedAt: 0, scannedAt: 0, complete: false, hasLabels: true, entries: {} }
      const read = await bash(APP_CACHE_SH + '; cat "$D/apps.json" 2>/dev/null || true', { timeoutMs: 20000, signal, stdoutMaxBytes: 8 * 1024 * 1024 })
      if (read.exitCode !== 0 || read.stdout.text.trim() === '') return empty
      let parsed = null
      try {
        parsed = JSON.parse(read.stdout.text)
      } catch (error) {
        return empty
      }
      if (parsed === null || typeof parsed !== 'object' || parsed.entries === undefined || parsed.entries === null) return empty
      return {
        generatedAt: Number(parsed.generatedAt) || 0,
        scannedAt: Number(parsed.scannedAt) || 0,
        complete: parsed.complete === true,
        hasLabels: parsed.hasLabels !== false,
        entries: parsed.entries,
      }
    }

    async function saveAppIndex(index, signal) {
      const out = await bash(
        APP_CACHE_SH + '; mkdir -p "$D"; printf %s ' + hostQuote(JSON.stringify(index)) +
          ' > "$D/apps.json.tmp" && mv "$D/apps.json.tmp" "$D/apps.json"',
        { timeoutMs: 30000, signal },
      )
      if (out.exitCode !== 0) throw new Error('PhoneUse: could not cache the app index: ' + clip(out.stderr.text.trim(), 160))
    }

    /** pkg, base APK path, size, mtime and third-party flag for every package. */
    async function appApkRows(signal) {
      // Two bulk passes on purpose: one awk over `pm` output, one single `stat`
      // invocation for all ~490 APKs. The obvious per-package loop (a `stat` plus
      // a `grep` each) cost ~10 s of process spawning per refresh — measured, and
      // the reason a warm lookup still looked slow.
      const script = [
        APP_CACHE_SH + '; mkdir -p "$D"',
        'adb shell pm list packages -3 | tr -d "\\r" | sed "s/^package://" > "$D/third.txt"',
        'adb shell pm list packages -f | tr -d "\\r" | sed "s/^package://" | awk -F= \'NR==FNR { third[$1]=1; next } ' +
          '{ apk=$0; sub(/=[^=]*$/, "", apk); pkg=$NF; print pkg "\\t" apk "\\t" ((pkg in third) ? 1 : 0) }\' "$D/third.txt" - > "$D/pkgs.tsv"',
        'cut -f2 "$D/pkgs.tsv" | tr "\\n" "\\0" | xargs -0 stat -c "%n\\t%s\\t%Y" 2>/dev/null > "$D/stats.tsv"',
        'awk -F"\\t" \'NR==FNR { size[$1]=$2; mtime[$1]=$3; next } ' +
          '{ printf "%s\\t%s\\t%s\\t%s\\t%s\\n", $1, $2, (($2 in size) ? size[$2] : 0), (($2 in mtime) ? mtime[$2] : 0), $3 }\' "$D/stats.tsv" "$D/pkgs.tsv"',
      ].join('\n')
      const out = await bash(script, { timeoutMs: 60000, signal, stdoutMaxBytes: 8 * 1024 * 1024 })
      const rows = []
      for (const line of out.stdout.text.split('\n')) {
        const parts = line.split('\t')
        if (parts.length < 5 || parts[0] === '') continue
        rows.push({
          pkg: parts[0],
          apk: parts[1],
          size: Number(parts[2]) || 0,
          mtime: Number(parts[3]) || 0,
          third: parts[4] === '1',
        })
      }
      // Third-party APKs carry the names people actually ask for, so they are
      // scanned first: a scan cut short by the time budget still answers "微信".
      rows.sort(function (a, b) { return (b.third ? 1 : 0) - (a.third ? 1 : 0) })
      return rows
    }

    /** The one-APK label reader. Input lines are "apk=pkg" (package last, so the
     *  last `=` is the separator even though APK paths contain `=` themselves). */
    const LABEL_ONE = [
      '#!/data/data/com.termux/files/usr/bin/bash',
      'line="$1"; apk="${line%=*}"; pkg="${line##*=}"',
      'if [ ! -f "$apk" ]; then printf "%s\\t\\t\\n" "$pkg"; exit 0; fi',
      'labels=$(aapt2 dump badging "$apk" 2>/dev/null | awk -F"\'" \'/^application-label:/{d=$2} /^application-label-zh/{z=z (z==""?"":"|") $2} END{printf "%s\\t%s", d, z}\')',
      'printf "%s\\t%s\\n" "$pkg" "$labels"',
    ].join('\n')

    function scanPreamble() {
      return [
        'export PATH="${PREFIX:-/data/data/com.termux/files/usr}/bin:$PATH"',
        APP_CACHE_SH + '; mkdir -p "$D"',
        'command -v aapt2 >/dev/null 2>&1 || { printf "NOAAPT2\\n"; exit 0; }',
        "cat > \"$D/label-one.sh\" <<'PHONEUSE_LABEL_ONE'",
        LABEL_ONE,
        'PHONEUSE_LABEL_ONE',
        'chmod +x "$D/label-one.sh"',
      ]
    }

    /** Labels for the given "pkg=apk" lines; null when aapt2 is not installed. */
    async function scanAppLabels(lines, signal, budgetSeconds) {
      const script = scanPreamble().concat([
        "cat > \"$D/scan.raw\" <<'PHONEUSE_APK_LIST'",
        lines.join('\n'),
        'PHONEUSE_APK_LIST',
        'timeout ' + String(budgetSeconds) + ' xargs -P ' + String(APP_SCAN_PARALLEL) + ' -n 1 "$D/label-one.sh" < "$D/scan.raw"',
      ]).join('\n')
      const out = await bash(script, { timeoutMs: (budgetSeconds + 15) * 1000, signal, stdoutMaxBytes: 8 * 1024 * 1024 })
      if (out.stdout.text.indexOf('NOAAPT2') !== -1) return null
      return parseLabelRows(out.stdout.text)
    }

    /** Whatever the detached warm pass already produced, plus when it finished. */
    async function readWarmLabels(signal) {
      const out = await bash(
        APP_CACHE_SH + '; if [ -f "$D/labels.raw.tsv" ]; then stat -c "%Y" "$D/labels.raw.tsv"; cat "$D/labels.raw.tsv"; fi',
        { timeoutMs: 30000, signal, stdoutMaxBytes: 8 * 1024 * 1024 },
      )
      const text = out.stdout.text
      if (text.trim() === '') return { mtime: 0, rows: new Map(), running: false }
      const breakAt = text.indexOf('\n')
      const running = (await bash(APP_CACHE_SH + '; [ -f "$D/warm.lock" ] && printf yes || printf no', { timeoutMs: 15000, signal })).stdout.text.trim() === 'yes'
      if (breakAt === -1) return { mtime: Number(text.trim()) || 0, rows: new Map(), running }
      return { mtime: Number(text.slice(0, breakAt).trim()) || 0, rows: parseLabelRows(text.slice(breakAt + 1)), running }
    }

    /** Wait out an in-flight warm pass instead of scanning the same APKs twice. */
    async function warmLabelsWhenReady(signal, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      let warm = await readWarmLabels(signal)
      while (warm.running && warm.rows.size === 0 && Date.now() < deadline) {
        await bash('sleep 2', { timeoutMs: 8000, signal })
        warm = await readWarmLabels(signal)
      }
      return warm
    }

    /** Start the detached full scan once per session; it must never block a call. */
    let warmPassStarted = false
    function startAppIndexWarmPass() {
      if (warmPassStarted) return
      warmPassStarted = true
      const script = scanPreamble().concat([
        'touch "$D/warm.lock"; trap \'rm -f "$D/warm.lock"\' EXIT',
        'adb shell pm list packages -3 | tr -d "\\r" | sed "s/^package://" > "$D/third.txt"',
        'adb shell pm list packages -f | tr -d "\\r" | sed "s/^package://" ' +
          '| awk -F= \'NR==FNR { third[$1]=1; next } { print (($NF) in third ? 1 : 0) "\\t" $0 }\' "$D/third.txt" - ' +
          '| sort -s -k1,1r | cut -f2- > "$D/scan.raw"',
        'timeout 300 xargs -P ' + String(APP_SCAN_PARALLEL) + ' -n 1 "$D/label-one.sh" < "$D/scan.raw" > "$D/labels.raw.tmp"',
        'mv "$D/labels.raw.tmp" "$D/labels.raw.tsv"',
      ]).join('\n')
      const detached = APP_CACHE_SH + '; mkdir -p "$D"; nohup bash -c ' + hostQuote(script) + ' >"$D/warm.log" 2>&1 &'
      Promise.resolve(bash(detached, { timeoutMs: 20000 })).catch(function () {})
    }

    async function ensureAppIndex(signal, options) {
      const index = await loadAppIndex(signal)
      const force = options !== undefined && options.force === true
      const fresh = index.generatedAt > 0 && Date.now() - index.generatedAt < APP_INDEX_TTL_MS
      // An incomplete pass is retried soon, but not on every call in one burst.
      const retry = index.complete === false && Date.now() - index.scannedAt > 15000
      if (!force && fresh && !retry) return index
      return await refreshAppIndex(index, signal)
    }

    async function refreshAppIndex(index, signal) {
      const rows = await appApkRows(signal)
      const installed = new Set(rows.map(function (row) { return row.pkg }))
      for (const pkg of Object.keys(index.entries)) if (!installed.has(pkg)) delete index.entries[pkg]
      const stale = rows.filter(function (row) {
        const known = index.entries[row.pkg]
        if (known === undefined || known.apk !== row.apk || known.size !== row.size || known.mtime !== row.mtime) return true
        return typeof known.label !== 'string'
      })
      if (stale.length === 0 || index.hasLabels === false) {
        index.complete = true
      } else {
        const warm = stale.length > 0 ? await warmLabelsWhenReady(signal, 30000) : { mtime: 0, rows: new Map() }
        const need = []
        for (const row of stale) {
          const hit = warm.rows.get(row.pkg)
          if (hit !== undefined && warm.mtime >= row.mtime) mergeIndexEntry(index, row, hit)
          else need.push(row)
        }
        if (need.length === 0) {
          index.complete = true
        } else {
          const scanned = await scanAppLabels(need.map(function (row) { return row.apk + '=' + row.pkg }), signal, APP_SCAN_BUDGET_S)
          if (scanned === null) {
            index.hasLabels = false
            index.complete = true
          } else {
            for (const row of need) {
              const hit = scanned.get(row.pkg)
              if (hit !== undefined) mergeIndexEntry(index, row, hit)
            }
            index.complete = scanned.size >= need.length
          }
        }
      }
      index.scannedAt = Date.now()
      index.generatedAt = Date.now()
      await saveAppIndex(index, signal)
      return index
    }

    /** Rank installed apps against a spoken name; higher is better. */
    function matchApps(index, query) {
      const needle = normalizeName(query)
      const hits = []
      if (needle === '') return hits
      for (const pkg of Object.keys(index.entries)) {
        const entry = index.entries[pkg]
        const labels = [typeof entry.label === 'string' ? entry.label : '']
        if (typeof entry.zh === 'string' && entry.zh !== '') labels.push.apply(labels, entry.zh.split('|'))
        let rank = 0
        for (const label of labels) {
          const value = normalizeName(label)
          if (value === '') continue
          if (value === needle) rank = Math.max(rank, 100)
          else if (value.indexOf(needle) === 0) rank = Math.max(rank, 70)
          else if (value.indexOf(needle) !== -1) rank = Math.max(rank, 50)
        }
        const name = normalizeName(pkg)
        if (name === needle) rank = Math.max(rank, 120)
        else if (name.endsWith(needle)) rank = Math.max(rank, 90)
        else if (name.indexOf(needle) !== -1) rank = Math.max(rank, 45)
        if (rank > 0) hits.push({ package: pkg, label: labels[0], rank })
      }
      hits.sort(function (a, b) { return b.rank - a.rank || a.package.length - b.package.length })
      return hits
    }

    /** Package-name-only match, so a package query never needs the APK scan. */
    async function matchPackagesByName(query, signal) {
      const out = await shellText('pm list packages', { timeoutMs: 40000, signal })
      const needle = normalizeName(query)
      const hits = []
      for (const line of out.split('\n')) {
        const pkg = line.replace('package:', '').trim()
        if (pkg === '') continue
        const name = normalizeName(pkg)
        let rank = 0
        if (name === needle) rank = 120
        else if (name.endsWith(needle)) rank = 90
        else if (name.indexOf(needle) !== -1) rank = 45
        if (rank > 0) hits.push({ package: pkg, rank })
      }
      hits.sort(function (a, b) { return b.rank - a.rank || a.package.length - b.package.length })
      return hits
    }

    /** Package -> launcher component; '' when the package has no launcher entry. */
    async function launcherComponent(pkg, signal) {
      const resolved = await shellText(
        'cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ' +
          hostQuote(pkg) + ' 2>&1 | tail -1',
        { timeoutMs: 40000, signal },
      )
      const component = resolved.trim().split('\n').pop().trim()
      if (component.indexOf('/') === -1 || /\s/.test(component)) return ''
      return component
    }

    harness.registerTool(ctx, harness.defineTool({
      name: 'phone_status',
      description: 'Report whether this Android phone is reachable through adb, plus model, screen size, screen wake state, and the foreground app. When the link is down it first rescans for the wireless-debugging port and reconnects on its own, so a stale port is not a dead end. Call it first, and after any phone_* failure, to tell "the phone is unreachable" apart from "the action failed".',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_args, value) => textBlocks(value) },
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        let listing = await adbText('devices', { timeoutMs: 20000, signal: exec.signal })
        let recovered = null
        if (!/\tdevice\b/.test(listing)) {
          const attempt = await reconnect(exec.signal)
          listing = await adbText('devices', { timeoutMs: 20000, signal: exec.signal })
          if (!/\tdevice\b/.test(listing)) {
            return {
              connected: false,
              adb_devices: listing.trim(),
              port_scan: attempt.ports.length === 0
                ? 'no listener on 127.0.0.1:30000-49999 — Wireless debugging looks off (Android turns it off on reboot)'
                : 'found ' + attempt.ports.join(', ') + ', but connecting did not take',
              hint: 'Open 开发者选项 → 无线调试, then call phone_status again: the port is discovered automatically.',
            }
          }
          recovered = attempt.port
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
          ...(recovered === null ? {} : { reconnected_via_port_scan: recovered }),
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


    /**
     * Best-effort read-back: does the focused window's tree show this text?
     * `null` means the tree could not be read at all, and `false` is not proof the
     * paste failed — password fields and some WebViews never expose their value.
     */
    async function textLanded(text, signal) {
      try {
        const screen = await dumpScreen(signal)
        for (const node of screen.nodes) {
          if (node.text.indexOf(text) !== -1) return true
        }
        return false
      } catch (error) {
        return null
      }
    }

    harness.registerTool(ctx, harness.defineTool({
      name: 'phone_text',
      description: 'Type text into the focused field (tap the field first). Text is delivered by setting the device clipboard and sending PASTE, which bypasses the on-screen keyboard entirely; without the Termux:API app it falls back to `input text`. The paste route replaces the device clipboard.',
      parameters: {
        text: { type: 'string', required: true, description: 'The text to type.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => textBlocks(value) },
      async execute(args, exec) {
        await assertDevice(exec.signal)
        const text = String(args.text)
        const signal = exec.signal

        // Clipboard first, NOT `input text`. Injected key events travel through
        // the active IME, and a composing keyboard swallows them: measured on
        // this device, `input text 'phoneuse-ok'` left the field reading "－" —
        // the letters became a discarded pinyin composition and only the hyphen
        // survived, as full-width punctuation. A paste never enters the IME.
        const probe = await bash('command -v termux-clipboard-set || printf ""', { timeoutMs: 15000, signal })
        if (probe.stdout.text.trim() !== '') {
          const copied = await bash('termux-clipboard-set ' + hostQuote(text), { timeoutMs: 20000, signal })
          if (copied.exitCode !== 0) {
            throw new Error('PhoneUse: termux-clipboard-set failed: ' + clip((copied.stderr.text || copied.stdout.text).trim(), 200) + ' (is the Termux:API app installed?)')
          }
          await shellText('input keyevent 279', { timeoutMs: 30000, signal })
          const landed = await textLanded(text, signal)
          return {
            ok: true,
            typed: text,
            route: 'clipboard + PASTE',
            clipboard_replaced: true,
            landed_in_tree: landed,
            note: landed === false
              ? 'Not visible in the accessibility tree: normal for password fields and some WebViews, otherwise re-check the field with phone_ui.'
              : 'Verify with phone_ui if it matters.',
          }
        }

        if (!/^[\x20-\x7E]*$/.test(text)) {
          throw new Error('PhoneUse: non-ASCII text needs the Termux:API app (termux-clipboard-set); `input text` cannot type it.')
        }
        await shellText('input text ' + hostQuote(escapeInputText(text)), { timeoutMs: 30000, signal })
        return {
          ok: true,
          typed: text,
          route: 'input text',
          warning: 'No Termux:API app, so this went through the on-screen IME; a composing keyboard can drop or transform characters. Check the field with phone_ui.',
        }
      },
    }))

    harness.registerTool(ctx, harness.defineTool({
      name: 'phone_app',
      description: 'Inspect or control apps: action=current reads the foreground app, action=list lists installed packages with their display names (third-party by default, `filter` matches the display name, a known nickname or the package), action=start launches an app by package name OR by the name a person says ("微信", "推特", "QQ"), action=alias teaches a spoken name -> package (or lists the known ones), action=stop force-stops a package.',
      parameters: {
        action: { type: 'string', required: true, enum: ['current', 'list', 'start', 'stop', 'alias'], description: 'What to do.' },
        target: { type: 'string', description: 'For start/stop: a package name (com.android.settings), a display name (微信 / QQ / 推特), or, for start, an http(s) URL. For alias: the spoken name to teach (omit it to list the known ones).' },
        package: { type: 'string', description: 'For alias: the package that spoken name should launch.' },
        filter: { type: 'string', description: 'For list: only apps whose display name or package contains this substring.' },
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
          const index = await ensureAppIndex(exec.signal)
          const aliases = await aliasMap(exec.signal)
          const aka = new Map()
          for (const [name, target] of aliases) {
            if (!aka.has(target)) aka.set(target, [])
            aka.get(target).push(name)
          }
          const out = await shellText('pm list packages ' + (args.all === true ? '' : '-3 '), { timeoutMs: 40000, signal: exec.signal })
          let names = out.split('\n').map((line) => line.replace('package:', '').trim()).filter((line) => line !== '')
          const needle = normalizeName(filter)
          if (needle !== '') {
            names = names.filter(function (pkg) {
              if (normalizeName(pkg).indexOf(needle) !== -1) return true
              const spoken = aka.get(pkg)
              if (spoken !== undefined && spoken.some(function (name) { return name.indexOf(needle) !== -1 })) return true
              const entry = index.entries[pkg]
              if (entry === undefined) return false
              const labels = [typeof entry.label === 'string' ? entry.label : '']
              if (typeof entry.zh === 'string' && entry.zh !== '') labels.push.apply(labels, entry.zh.split('|'))
              return labels.some(function (label) { return normalizeName(label).indexOf(needle) !== -1 })
            })
          }
          const apps = names.map(function (pkg) {
            const entry = index.entries[pkg]
            const row = { package: pkg, label: entry === undefined || entry.label === undefined ? '' : entry.label }
            const spoken = aka.get(pkg)
            if (spoken !== undefined) row.aka = spoken
            return row
          })
          return {
            action,
            filter,
            count: apps.length,
            apps: apps.slice(0, 100),
            packages: names.slice(0, 100),
            third_party_only: args.all !== true,
            labels_ready: index.hasLabels !== false && index.complete === true,
            truncated: names.length > 100,
          }
        }
        const target = args.target === undefined || args.target === null ? '' : String(args.target).trim()
        if (action === 'alias') {
          const learned = await loadAliases(exec.signal)
          if (target === '') {
            return {
              action,
              learned: Object.keys(learned.learned).map(function (name) { return { name, package: learned.learned[name] } }),
              curated: Object.keys(learned.curated).map(function (name) { return { name, package: learned.curated[name] } }),
              curated_count: Object.keys(learned.curated).length,
              hint: 'Teach one with phone_app action=alias target="推特" package="com.twitter.android"; start/list then match it too.',
            }
          }
          const aliasPkg = args.package === undefined || args.package === null ? '' : String(args.package).trim()
          if (aliasPkg === '') {
            throw new Error('PhoneUse: action "alias" needs `package` (phone_app action=alias target="推特" package="com.twitter.android"), or omit target to list the known names.')
          }
          const installed = await shellText('pm list packages ' + hostQuote(aliasPkg), { timeoutMs: 30000, signal: exec.signal })
          if (installed.indexOf('package:' + aliasPkg) === -1) {
            throw new Error('PhoneUse: "' + aliasPkg + '" is not installed, so the alias was not saved — check phone_app action=list.')
          }
          const saved = await saveAlias(target, aliasPkg, exec.signal)
          return { action, name: target, package: aliasPkg, ok: true, learned_count: Object.keys(saved).length }
        }
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
          // Resolve the package's launcher activity, then start it with `am start`.
          // Never launch with `monkey`: on MIUI/HyperOS the Monkey runtime writes
          // Settings.System.ACCELEROMETER_ROTATION=1 as it starts up (measured: the
          // SettingsProvider write lands ~5 ms after "Events injected"), which
          // silently turns the user's rotation lock off. `am start` does not.
          //
          // The target may be a package, a name a person says, or an alias. A
          // package answers on the first adb call; a name only needs the APK
          // label index (~21 s cold once, <1 s warm) when nothing cheaper hit.
          const wanted = target
          let pkg = target
          let matchedBy = 'package'
          let component = await launcherComponent(target, exec.signal)
          if (component === '') {
            const alias = (await aliasMap(exec.signal)).get(normalizeName(target))
            if (alias !== undefined) {
              const byAlias = await launcherComponent(alias, exec.signal)
              if (byAlias !== '') {
                component = byAlias
                pkg = alias
                matchedBy = 'alias'
              }
            }
          }
          if (component === '') {
            const byName = await matchPackagesByName(target, exec.signal)
            if (byName.length > 0 && byName[0].rank >= 90 && (byName.length === 1 || byName[0].rank > byName[1].rank)) {
              const byPackage = await launcherComponent(byName[0].package, exec.signal)
              if (byPackage !== '') {
                component = byPackage
                pkg = byName[0].package
                matchedBy = 'package-name'
              }
            }
          }
          if (component === '') {
            let index = await ensureAppIndex(exec.signal)
            let hits = matchApps(index, target)
            if (hits.length === 0 || hits[0].rank < 90) {
              index = await ensureAppIndex(exec.signal, { force: true })
              hits = matchApps(index, target)
            }
            if (hits.length === 0) {
              const why = index.hasLabels === false
                ? ' (display names are unavailable: `pkg install aapt` in Termux turns them on)'
                : index.complete === false ? ' (the app-name index is still filling in — retry once)' : ''
              throw new Error('PhoneUse: no installed app matches "' + wanted + '"' + why + '. Use phone_app action=list with a `filter`, or the package name.')
            }
            if (hits.length > 1 && hits[1].rank === hits[0].rank) {
              throw new Error('PhoneUse: "' + wanted + '" matches several apps — pass one of: ' +
                hits.slice(0, 5).map(function (hit) { return hit.package + ' (' + hit.label + ')' }).join(', '))
            }
            const byLabel = await launcherComponent(hits[0].package, exec.signal)
            if (byLabel === '') throw new Error('PhoneUse: ' + hits[0].package + ' has no launcher activity.')
            component = byLabel
            pkg = hits[0].package
            matchedBy = 'label'
          }
          const out = await shellText(
            'am start -n ' + hostQuote(component) + ' 2>&1 | tail -3',
            { timeoutMs: 40000, signal: exec.signal },
          )
          if (/Error type|Exception|does not exist|unable to resolve/i.test(out)) {
            throw new Error('PhoneUse: could not launch "' + wanted + '" (' + component + '): ' + clip(out.trim(), 160))
          }
          return { action, package: pkg, component, matched_by: matchedBy, ok: true, detail: clip(out.trim(), 200) }
        }
        throw new Error('PhoneUse: unknown action "' + action + '".')
      },
    }))
  },
}
