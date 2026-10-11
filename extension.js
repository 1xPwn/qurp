import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup';
import Pango from 'gi://Pango';

import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const CONFIG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'qurp']);
const LOG_FILE = GLib.build_filenamev([CONFIG_DIR, 'client.log']);
const CACHE_FILE = GLib.build_filenamev([CONFIG_DIR, 'servers-cache.json']);
// the core config holds credentials: keep it in the per-user runtime dir (tmpfs, 0700), not /tmp
const RUNTIME_DIR = GLib.get_user_runtime_dir() || GLib.get_tmp_dir();
const PROXY_CONFIG_FILE = GLib.build_filenamev([RUNTIME_DIR, 'qurp-singbox.json']);
const KS_FLAG_FILE = GLib.build_filenamev([CONFIG_DIR, 'ks-active']);
const PROXY_BACKUP_FILE = GLib.build_filenamev([CONFIG_DIR, 'proxy-backup.json']);
const MIN_CORE = [1, 12];
// install.sh --tun puts a copy of sing-box here (owner-only) and gives THAT copy the network
// capabilities, instead of the system binary that every local process can run
const CORE_PRIVATE = GLib.build_filenamev([GLib.get_user_data_dir(), 'qurp', 'bin', 'sing-box']);

// St.Widget has no built-in tooltip_text (unlike Gtk). Show a small label on hover.
const TIP_DELAY_MS = 450;
function attachHoverTip(actor, textOrFn) {
    if (!actor)
        return;
    try {
        actor.track_hover = true;
        actor.reactive = true;
    } catch (e) { /* ignore */ }

    let timeoutId = 0;
    let tip = null;

    const tipText = () => {
        try {
            const v = typeof textOrFn === 'function' ? textOrFn() : textOrFn;
            return v ? String(v) : '';
        } catch (e) {
            return '';
        }
    };

    const destroyTip = () => {
        if (timeoutId) {
            GLib.source_remove(timeoutId);
            timeoutId = 0;
        }
        if (tip) {
            try { tip.destroy(); } catch (e) { /* ignore */ }
            tip = null;
        }
    };

    const showTip = () => {
        try {
            const text = tipText();
            if (!text)
                return;

            if (!tip) {
                tip = new St.Label({
                    style_class: 'qurp-tooltip',
                    text,
                });
                Main.layoutManager.addTopChrome(tip);
            } else {
                tip.text = text;
            }

            const [ax, ay] = actor.get_transformed_position();
            const [aw, ah] = actor.get_transformed_size();
            tip.show();

            // Clutter returns [minW, minH, natW, natH]
            let tw = 80, th = 24;
            try {
                const pref = tip.get_preferred_size();
                if (Array.isArray(pref) && pref.length >= 4) {
                    tw = pref[2] || pref[0] || tw;
                    th = pref[3] || pref[1] || th;
                } else if (tip.width > 0) {
                    tw = tip.width;
                    th = tip.height;
                }
            } catch (e) { /* keep defaults */ }

            const monitor = (Main.layoutManager.findMonitorForActor
                && Main.layoutManager.findMonitorForActor(actor))
                || Main.layoutManager.primaryMonitor;

            let x = Math.round(ax + (aw - tw) / 2);
            let y = Math.round(ay + ah + 8);
            if (monitor) {
                const left = monitor.x + 4;
                const right = monitor.x + monitor.width - tw - 4;
                const bottom = monitor.y + monitor.height - th - 4;
                x = Math.max(left, Math.min(x, right));
                if (y > bottom)
                    y = Math.round(ay - th - 8);
            }
            tip.set_position(x, y);
            tip.opacity = 255;
        } catch (e) {
            Log?.warn?.(`tooltip: ${e.message}`);
            destroyTip();
        }
    };

    actor.connect('notify::hover', () => {
        if (actor.hover) {
            if (timeoutId)
                GLib.source_remove(timeoutId);
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TIP_DELAY_MS, () => {
                timeoutId = 0;
                if (actor.hover)
                    showTip();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            destroyTip();
        }
    });
    actor.connect('destroy', destroyTip);
}

// The shell's own PATH is often shorter than a terminal's (no ~/.local/bin, ~/go/bin...), so after the
// PATH lookup a few usual places are tried too.
function systemCore() {
    const inPath = GLib.find_program_in_path('sing-box');
    if (inPath) return inPath;
    const home = GLib.get_home_dir();
    for (const dir of ['/usr/local/bin', '/usr/bin', '/bin', '/usr/local/sbin', '/opt/sing-box',
        GLib.build_filenamev([home, '.local', 'bin']), GLib.build_filenamev([home, 'go', 'bin']),
        GLib.build_filenamev([home, 'bin'])]) {
        const p = GLib.build_filenamev([dir, 'sing-box']);
        if (GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) return p;
    }
    return null;
}

function coreBin(tun) {
    if (tun && GLib.file_test(CORE_PRIVATE, GLib.FileTest.IS_EXECUTABLE))
        return CORE_PRIVATE;
    return systemCore() ?? 'sing-box';
}
const SUPPORTED_NETS = new Set(['tcp', 'ws', 'grpc', 'http', 'h2', 'httpupgrade']);
const IR_DIRECT = ['ir', 'aparat.com', 'digikala.com', 'filimo.com', 'telewebion.com'];
const MAX_LOG_LINES = 300;
const MAX_SUBS = 10;

/** Pull a clean subscription URL out of messy clipboard text (chat apps, quotes, trailing junk). */
function extractSubUrl(raw) {
    let t = String(raw || '').trim();
    if (!t)
        return null;
    // strip surrounding quotes / backticks
    if ((t.startsWith('"') && t.endsWith('"')) ||
        (t.startsWith("'") && t.endsWith("'")) ||
        (t.startsWith('`') && t.endsWith('`')))
        t = t.slice(1, -1).trim();
    // angle-bracket form: <https://...>
    const angle = t.match(/<(https?:\/\/[^>]+)>/i);
    if (angle)
        t = angle[1].trim();
    // first http(s) token in the blob
    const m = t.match(/https?:\/\/[^\s<>"'\\]+/i);
    if (!m)
        return null;
    let url = m[0];
    // strip trailing punctuation that chat/markdown often leaves on
    url = url.replace(/[),.;:!?\]]+$/g, '');
    // drop a lone trailing slash-only fragment noise, keep real paths
    try {
        const u = GLib.Uri.parse(url, GLib.UriFlags.NONE);
        if (!u || !u.get_host())
            return null;
        // rebuild a stable form (rejects spaces etc.)
        const scheme = (u.get_scheme() || '').toLowerCase();
        if (scheme !== 'http' && scheme !== 'https')
            return null;
        return url;
    } catch (e) {
        return null;
    }
}

const SERVER_LIST_MAX_HEIGHT = 950;
const SERVER_LIST_MIN_HEIGHT = 450;
const VERSION_CHECK_SECS = 12 * 3600;   // twice a day

const COUNTRY_INFO = {
    US: {flag: '🇺🇸', name: 'United States'}, GB: {flag: '🇬🇧', name: 'United Kingdom'},
    UK: {flag: '🇬🇧', name: 'United Kingdom'}, DE: {flag: '🇩🇪', name: 'Germany'},
    FR: {flag: '🇫🇷', name: 'France'}, NL: {flag: '🇳🇱', name: 'Netherlands'},
    RU: {flag: '🇷🇺', name: 'Russia'}, IN: {flag: '🇮🇳', name: 'India'},
    BR: {flag: '🇧🇷', name: 'Brazil'}, CA: {flag: '🇨🇦', name: 'Canada'},
    JP: {flag: '🇯🇵', name: 'Japan'}, KR: {flag: '🇰🇷', name: 'South Korea'},
    SG: {flag: '🇸🇬', name: 'Singapore'}, TR: {flag: '🇹🇷', name: 'Turkey'},
    AE: {flag: '🇦🇪', name: 'UAE'}, FI: {flag: '🇫🇮', name: 'Finland'},
    SE: {flag: '🇸🇪', name: 'Sweden'}, NO: {flag: '🇳🇴', name: 'Norway'},
    CH: {flag: '🇨🇭', name: 'Switzerland'}, AU: {flag: '🇦🇺', name: 'Australia'},
    IT: {flag: '🇮🇹', name: 'Italy'}, ES: {flag: '🇪🇸', name: 'Spain'},
    PL: {flag: '🇵🇱', name: 'Poland'}, RO: {flag: '🇷🇴', name: 'Romania'},
    CZ: {flag: '🇨🇿', name: 'Czechia'}, UA: {flag: '🇺🇦', name: 'Ukraine'},
    HK: {flag: '🇭🇰', name: 'Hong Kong'}, TW: {flag: '🇹🇼', name: 'Taiwan'},
    IR: {flag: '🇮🇷', name: 'Iran'}, AT: {flag: '🇦🇹', name: 'Austria'},
    BE: {flag: '🇧🇪', name: 'Belgium'}, IE: {flag: '🇮🇪', name: 'Ireland'},
};

const NAME_HINTS = [
    ['UNITED KINGDOM', 'GB'], ['GREAT BRITAIN', 'GB'], ['ENGLAND', 'GB'],
    ['UNITED STATES', 'US'], ['AMERICA', 'US'], ['USA', 'US'],
    ['GERMANY', 'DE'], ['FRANCE', 'FR'], ['NETHERLANDS', 'NL'], ['HOLLAND', 'NL'],
    ['TURKEY', 'TR'], ['SINGAPORE', 'SG'], ['JAPAN', 'JP'], ['KOREA', 'KR'],
    ['CANADA', 'CA'], ['AUSTRALIA', 'AU'], ['SWEDEN', 'SE'], ['FINLAND', 'FI'],
    ['NORWAY', 'NO'], ['SWITZERLAND', 'CH'], ['POLAND', 'PL'], ['SPAIN', 'ES'],
    ['ITALY', 'IT'], ['BRAZIL', 'BR'], ['INDIA', 'IN'], ['RUSSIA', 'RU'],
    ['HONG KONG', 'HK'], ['TAIWAN', 'TW'], ['UKRAINE', 'UA'], ['AUSTRIA', 'AT'],
    ['UAE', 'AE'], ['DUBAI', 'AE'], ['IRELAND', 'IE'],
];

/* ---------- i18n ---------- */

class I18n {
    constructor(extension) {
        this._ext = extension;
        this._dict = {};
        this._lang = 'en';
    }

    load(lang) {
        this._lang = lang || 'en';
        try {
            const file = this._ext.dir.get_child('locales').get_child(`${this._lang}.json`);
            const [ok, contents] = file.load_contents(null);
            if (ok)
                this._dict = JSON.parse(new TextDecoder().decode(contents));
        } catch (e) {
            this._dict = {};
        }
        if (this._lang !== 'en') {
            try {
                const file = this._ext.dir.get_child('locales').get_child('en.json');
                const [ok, contents] = file.load_contents(null);
                if (ok) {
                    const en = JSON.parse(new TextDecoder().decode(contents));
                    this._dict = {...en, ...this._dict};
                }
            } catch (e) { /* ignore */ }
        }
    }

    t(key, vars) {
        let s = this._dict[key] ?? key;
        if (vars) {
            for (const [k, v] of Object.entries(vars))
                s = s.split(`{${k}}`).join(String(v));
        }
        return s;
    }

    get isRtl() {
        return this._lang === 'fa';
    }
}

/* ---------- helpers ---------- */

function decodeBase64(text) {
    // also accept the URL-safe alphabet (- and _): GLib would silently drop those characters
    let value = text.trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    value += '='.repeat((4 - value.length % 4) % 4);
    return new TextDecoder().decode(GLib.base64_decode(value));
}

function safeDecode(v) {
    try {
        return decodeURIComponent(v);
    } catch (e) {
        return v;           // malformed %-escape: keep the text as written
    }
}

function parseQuery(query) {
    const q = {};
    if (!query) return q;
    for (const part of query.split('&')) {
        const eq = part.indexOf('=');
        if (eq < 0) {
            if (part) q[safeDecode(part)] = '';
            continue;
        }
        const k = safeDecode(part.slice(0, eq));
        const v = safeDecode(part.slice(eq + 1));
        if (k) q[k] = v;
    }
    return q;
}

function safeUri(link) {
    return GLib.Uri.parse(String(link).replace(/\s/g, '%20'),
        GLib.UriFlags.HAS_PASSWORD | GLib.UriFlags.ENCODED);
}

// Two-letter codes that are also everyday English words: only trusted as "IN-1", "IT 02" or "[IN]"
const AMBIGUOUS_CODES = new Set(['IN', 'IT', 'NO', 'AT', 'BE', 'AS', 'IS', 'ON', 'OK', 'TO', 'DO', 'SO',
    'MY', 'ME', 'AM', 'AN', 'BY', 'OR', 'IF', 'HE', 'ID']);

function flagEmojiCode(raw) {
    const cps = [...raw].map(c => c.codePointAt(0));
    for (let i = 0; i + 1 < cps.length; i++) {
        const a = cps[i], b = cps[i + 1];
        if (a >= 0x1F1E6 && a <= 0x1F1FF && b >= 0x1F1E6 && b <= 0x1F1FF) {
            const code = String.fromCharCode(65 + a - 0x1F1E6, 65 + b - 0x1F1E6);
            if (COUNTRY_INFO[code]) return code;
        }
    }
    return '';
}

function detectCountry(rawName) {
    const raw = String(rawName || '');
    const fromFlag = flagEmojiCode(raw);
    if (fromFlag) return fromFlag;

    // country names must be whole words ("Indianapolis" is not India)
    const words = raw.toUpperCase().split(/[^A-Z]+/).filter(Boolean);
    const padded = ` ${words.join(' ')} `;
    for (const [hint, code] of NAME_HINTS) {
        if (!padded.includes(` ${hint} `)) continue;
        if (hint === 'AMERICA' && /(SOUTH|NORTH|LATIN|CENTRAL) AMERICA/.test(padded)) continue;
        if (hint === 'KOREA' && padded.includes(' NORTH KOREA ')) continue;
        return code;
    }

    // codes: written in capitals as a separate word ("DE", "NY-US-1"); lower-case words are never codes
    for (const code of Object.keys(COUNTRY_INFO)) {
        if (!new RegExp(`(^|[^A-Za-z])${code}([^A-Za-z]|$)`).test(raw)) continue;
        if (AMBIGUOUS_CODES.has(code) &&
            !new RegExp(`[\\[(]${code}[\\])]|(^|[^A-Za-z])${code}[-_ ]?\\d`).test(raw))
            continue;
        return code;
    }
    return '';
}

function isIpAddress(v) {
    v = String(v || '');
    const m4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
    if (m4) return m4.slice(1).every(o => Number(o) <= 255);
    return /^[0-9a-fA-F:]+$/.test(v) && (v.match(/:/g) || []).length >= 2;
}

function normNet(n) {
    let v = String(n || 'tcp').toLowerCase();
    if (v === 'raw' || v === '') v = 'tcp';
    if (v === 'websocket') v = 'ws';
    if (v === 'http2') v = 'h2';
    return v;
}

// '' when sing-box can carry the link; otherwise a short reason shown to the user
function unsupportedReason(network, headerType, encryption) {
    if (!SUPPORTED_NETS.has(network)) return network;
    if (encryption && encryption !== 'none') return 'vless-encryption';
    if (network === 'tcp' && String(headerType || '').toLowerCase() === 'http') return 'http-header';
    return '';
}

function displayName(server) {
    const code = server.country || detectCountry(server.rawName);
    const info = COUNTRY_INFO[code];
    if (info) return `${info.flag}  ${info.name}`;
    let n = String(server.rawName || 'Server');
    n = n.replace(/\([^)]*\)/g, '').replace(/[0-9a-f]{8,}/gi, '').replace(/[_-]+/g, ' ').trim();
    return n ? `🌐  ${n}` : '🌐  Server';
}

function isTrue(v) {
    return ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase());
}

function formatRate(bps) {
    return `${formatBytes(bps)}/s`;
}

function splitList(text) {
    return String(text || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
}

function formatAgo(iso, t) {
    const ts = Date.parse(iso);
    if (!ts) return '';
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) return t('ago_now');
    if (mins < 60) return t('ago_min', {n: mins});
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t('ago_hour', {n: hours});
    return t('ago_day', {n: Math.floor(hours / 24)});
}

// What to do about each error, written for client.log (always English): the exact command or setting.
const ERROR_HINTS = {
    core_missing: d => `sing-box was not found (looked for "${d || 'sing-box'}"). FIX: run ./install.sh --install-core in the Qurp folder ` +
        '(or see "Installing sing-box" in the README), then log out and back in. ' +
        `Searched PATH=${GLib.getenv('PATH')} and /usr/local/bin, /usr/bin, ~/.local/bin, ~/go/bin, ~/bin.`,
    core_failed: d => `sing-box exists but cannot be started (${d}). FIX: check permissions (ls -l $(command -v sing-box)), ` +
        'the architecture (file $(command -v sing-box)) and SELinux (sudo ausearch -m avc -ts recent).',
    core_too_old: d => `sing-box is too old (${d}); Qurp needs 1.12 or newer. FIX: ./install.sh --install-core, then log out and back in.`,
    port_busy: d => `Local proxy port ${d} is used by another program. FIX: change the port in Settings > Advanced, or stop that program.`,
    tun_needs_setup: () => 'TUN mode needs network capabilities for sing-box. FIX: run ./install.sh --tun in the Qurp folder, then connect again.',
    helper_missing: () => 'The kill switch is on but its helper is not installed. FIX: run ./install.sh --helper, or turn the kill switch off in Settings > Advanced.',
    ks_failed: d => `The kill switch could not be applied (${d}); the connection was aborted so nothing leaks. ` +
        'FIX: make sure nftables and polkit (pkexec) are installed (./install.sh --check tells you) and that you approved the authentication prompt.',
    unsupported_transport: d => `This server uses "${d}", which sing-box cannot carry. FIX: choose another server.`,
    clash_unsupported: () => 'This subscription is in Clash YAML format, which Qurp does not support. FIX: ask your provider for the plain link list or the sing-box JSON format.',
};

// logs the error and, on its own line, what the user can do about it
function logFailure(level, prefix, e) {
    const log = level === 'warn' ? Log.warn : Log.error;
    log.call(Log, `${prefix}: ${e?.message || e}`);
    const hint = e?.key && ERROR_HINTS[e.key] ? ERROR_HINTS[e.key](e.detail) : '';
    if (hint) log.call(Log, `  -> ${hint}`);
}

function keyedError(key, detail) {
    const e = new Error(detail ? `${key}: ${detail}` : key);
    e.key = key;
    e.detail = detail || '';
    return e;
}

const HELPER_PATH = '/usr/local/libexec/qurp-helper';
const TUN_IFACE = 'qurp0';
const DELAY_URL = 'https://www.gstatic.com/generate_204';

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

function randomSecret() {
    return GLib.uuid_string_random().replace(/-/g, '');
}

function findFreePort() {
    const listener = new Gio.SocketListener();
    try {
        return listener.add_any_inet_port(null);
    } finally {
        listener.close();
    }
}

function isPortFree(port) {
    const listener = new Gio.SocketListener();
    try {
        listener.add_inet_port(port, null);
        return true;
    } catch (e) {
        return false;
    } finally {
        listener.close();
    }
}

// One session for every call to the core's local API (it used to build a new one per request).
let _apiSession = null;
function apiSession() {
    if (!_apiSession) {
        _apiSession = new Soup.Session({timeout: 30});
        try {
            _apiSession.set_proxy_resolver(Gio.SimpleProxyResolver.new(null, null));
        } catch (e) { /* ignore */ }
    }
    return _apiSession;
}

function resetApiSession() {
    if (_apiSession) {
        try { _apiSession.abort(); } catch (e) { /* ignore */ }
        _apiSession = null;
    }
}

async function localGet(port, path, secret, timeoutSec = 10) {
    const session = apiSession();
    const message = Soup.Message.new('GET', `http://127.0.0.1:${port}${path}`);
    if (!message) throw new Error('invalid URL');
    message.get_request_headers().append('Authorization', `Bearer ${secret}`);
    // the session is shared, so its own timeout cannot differ per request: cancel this one instead
    const cancellable = new Gio.Cancellable();
    let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, timeoutSec) * 1000, () => {
        timer = 0;
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
    });
    try {
        return await new Promise((resolve, reject) => {
            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
                try {
                    const bytes = s.send_and_read_finish(res);
                    resolve({
                        status: message.get_status(),
                        text: new TextDecoder().decode(bytes.get_data()),
                    });
                } catch (e) { reject(e); }
            });
        });
    } finally {
        if (timer) GLib.source_remove(timer);
    }
}

async function resolveHost(host) {
    const bare = String(host).replace(/^\[|\]$/g, '');
    if (/^[0-9.]+$/.test(bare) || bare.includes(':'))
        return [bare];
    const addrs = await new Promise((resolve, reject) => {
        Gio.Resolver.get_default().lookup_by_name_async(bare, null, (r, res) => {
            try { resolve(r.lookup_by_name_finish(res)); } catch (e) { reject(e); }
        });
    });
    return addrs.map(a => a.to_string());
}

function splitDisplay(text) {
    const str = String(text || '');
    const i = str.indexOf('  ');
    if (i < 0) return {flag: '🌐', name: str};
    return {flag: str.slice(0, i), name: str.slice(i + 2)};
}

// Identifies a server across updates. The credential is hashed (this id is stored in GSettings and
// shows up in dconf dumps), and transport details are part of it so two variants of one endpoint
// (same host, port and uuid but different path / SNI) are no longer merged into one.
function stableId(server) {
    const cred = server.uuid || server.password || '';
    const parts = [server.protocol, server.host, server.port, cred, server.network || '',
        server.security || '', server.sni || '', server.path || '', server.serviceName || '',
        server.hostHeader || '', server.flow || '', server.publicKey || '',
        cred ? '' : (server.rawName || '')];
    const h = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, parts.join('|'), -1).slice(0, 20);
    return `${server.protocol}:${server.host}:${server.port}:${h}`;
}

function formatBytes(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = Math.max(0, Number(n));
    let i = 0;
    while (v >= 1024 && i < u.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/* ---------- Logger ---------- */

class Logger {
    constructor() {
        this._lines = [];
        this._added = 0;        // lines logged since the last write
        this._lastSize = 0;
        GLib.mkdir_with_parents(CONFIG_DIR, 0o700);
        try {
            const [ok, contents] = Gio.File.new_for_path(LOG_FILE).load_contents(null);
            if (ok) {
                this._lastSize = contents.length;
                this._lines = new TextDecoder().decode(contents)
                    .split('\n').filter(Boolean).slice(-MAX_LOG_LINES);
            }
        } catch (e) { /* ignore */ }
    }

    _now() {
        const d = new Date();
        const p = n => String(n).padStart(2, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }

    log(level, msg) {
        const line = `[${this._now()}] ${level}: ${msg}`;
        this._lines.push(line);
        this._added++;
        if (this._lines.length > MAX_LOG_LINES)
            this._lines = this._lines.slice(-MAX_LOG_LINES);
        // the shell's main loop must not stall on disk I/O: write at most once every 2 s
        if (!this._flushId) {
            this._flushId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 2000, () => {
                this._flushId = 0;
                this._write();
                return GLib.SOURCE_REMOVE;
            });
        }
        console.log(`Qurp ${line}`);
    }

    _write() {
        try {
            const file = Gio.File.new_for_path(LOG_FILE);
            // the settings window's "Clear logs" empties the file from outside: honour it and keep
            // only what was logged since our last write (the old buffer used to be written back)
            if (this._lastSize > 0) {
                let size = -1;
                try {
                    size = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
                } catch (e) { /* file is gone */ }
                if (size <= 0)
                    this._lines = this._added > 0 ? this._lines.slice(-this._added) : [];
            }
            const text = `${this._lines.join('\n')}\n`;
            file.replace_contents(
                text, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null
            );
            this._added = 0;
            this._lastSize = text.length;
        } catch (e) { /* ignore */ }
    }

    flush() {
        if (this._flushId) {
            GLib.source_remove(this._flushId);
            this._flushId = 0;
        }
        this._write();
    }

    info(m) { this.log('INFO', m); }
    warn(m) { this.log('WARN', m); }
    error(m) { this.log('ERROR', m); }
    getText() { return this._lines.join('\n'); }
    clear() {
        this._lines = [];
        this._added = 0;
        this._lastSize = 0;
        if (this._flushId) {
            GLib.source_remove(this._flushId);
            this._flushId = 0;
        }
        try {
            Gio.File.new_for_path(LOG_FILE).replace_contents(
                '', null, false, Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null
            );
        } catch (e) { /* ignore */ }
    }
}

const Log = new Logger();

/* ---------- Subscription ---------- */

const USAGE_FILE = GLib.build_filenamev([CONFIG_DIR, 'usage.json']);

function loadUsage() {
    try {
        const [ok, contents] = Gio.File.new_for_path(USAGE_FILE).load_contents(null);
        if (ok) {
            const obj = JSON.parse(new TextDecoder().decode(contents));
            if (obj && typeof obj === 'object') return obj;
        }
    } catch (e) { /* first run */ }
    return {};
}

function saveUsage(usage) {
    try {
        GLib.mkdir_with_parents(CONFIG_DIR, 0o700);
        Gio.File.new_for_path(USAGE_FILE).replace_contents(
            JSON.stringify(usage), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null
        );
    } catch (e) {
        Log.warn(`usage write: ${e.message}`);
    }
}

function median(values) {
    const a = values.slice().sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/*
 * Turn raw probe samples into one result.
 * samples: [{ok, ms, kind}] where kind is 'timeout' or 'error' for failures.
 * The first successful probe is treated as warm-up (DNS + cold handshake) and
 * dropped when at least two probes succeeded. Any lost probe, a single
 * success out of several, or a wide spread marks the result unstable.
 */
function aggregateProbes(samples) {
    const oks = samples.filter(s => s.ok).map(s => s.ms);
    if (!oks.length) {
        const last = samples[samples.length - 1];
        return {ms: -1, state: last?.kind === 'timeout' ? 'timeout' : 'error'};
    }
    const usable = oks.length >= 2 ? oks.slice(1) : oks;
    const ms = Math.round(median(usable));
    const lost = samples.length - oks.length;
    const hi = Math.max(...usable);
    const lo = Math.min(...usable);
    // a wide spread only counts when it is also big in absolute terms (3 ms vs 9 ms is not jitter)
    const wide = hi / Math.max(1, lo) > 2.5 && hi - lo > 50;
    const unstable = samples.length > 1 && (lost > 0 || oks.length < 2 || wide);
    return {ms, state: unstable ? 'unstable' : 'ok'};
}

function isFresh(server, staleMs) {
    return Boolean(server.pingAt) &&
        Date.now() - server.pingAt <= staleMs &&
        (server.pingState === 'ok' || server.pingState === 'unstable');
}

function latencyView(server, staleMs) {
    let state = server.pingState;
    if (!state) {
        if (server.latency === null || server.latency === undefined) state = null;
        else state = server.latency < 0 ? 'error' : 'ok';
    }
    let text, cls;
    if (state === null || state === 'na') {
        text = '—'; cls = 'qurp-lat-na';
    } else if (state === 'timeout') {
        text = 'timeout'; cls = 'qurp-lat-bad';
    } else if (state === 'error') {
        text = 'error'; cls = 'qurp-lat-bad';
    } else {
        const ms = server.latency;
        text = `${ms} ms${state === 'unstable' ? ' ~' : ''}`;
        cls = ms < 500 ? 'qurp-lat-ok' : (ms <= 1200 ? 'qurp-lat-mid' : 'qurp-lat-bad');
    }
    const stale = Boolean(server.pingAt) && staleMs > 0 && Date.now() - server.pingAt > staleMs;
    return {text, cls: stale ? `${cls} qurp-stale` : cls};
}

function subHealth(sub, now = Date.now()) {
    if (sub.enabled === false) return {state: 'disabled', dot: 'off'};
    if (sub.error) return {state: 'failed', dot: 'y'};
    const tr = sub.traffic;
    if (tr?.expire && tr.expire * 1000 < now) return {state: 'expired', dot: 'r'};
    if (tr?.total > 0 && tr.used >= tr.total) return {state: 'depleted', dot: 'r'};
    if (!sub.updatedAt) return {state: 'new', dot: 'y'};
    return {state: 'ok', dot: 'g'};
}

function usageFraction(sub) {
    const tr = sub.traffic;
    if (!tr || !(tr.total > 0)) return null;
    return Math.max(0, Math.min(1, tr.used / tr.total));
}

function subSummary(sub, t) {
    const parts = [];
    const tr = sub.traffic;
    if (tr) {
        if (tr.total > 0) parts.push(`${formatBytes(tr.used)} / ${formatBytes(tr.total)}`);
        else if (tr.used > 0) parts.push(formatBytes(tr.used));
        if (tr.expire) {
            const left = tr.expire * 1000 - Date.now();
            parts.push(left <= 0 ? t('expired') : t('days_left', {n: Math.ceil(left / 86400000)}));
        }
    }
    if (sub.error) parts.push(t('update_failed'));
    else if (sub.updatedAt) parts.push(formatAgo(sub.updatedAt, t));
    else parts.push(t('never'));
    return parts.join(' · ');
}

/*
 * Traffic accounting from the core's connection table.
 * The core's global counters include traffic that bypasses the proxy, so proxied
 * and direct bytes are tracked per connection (chains say which outbound carried
 * it). Connections seen at a poll are counted exactly. Bytes that moved on
 * connections that opened and closed between two polls are only visible in the
 * global counters: the total stays exact, and those bytes are split by the
 * proxied/direct ratio observed in the same interval (or over the session) and
 * counted separately as "estimated" so the UI can flag them.
 */
class TrafficTracker {
    constructor() {
        this.reset();
    }

    reset() {
        this.conns = new Map();
        this.proxy = {up: 0, down: 0};
        this.direct = {up: 0, down: 0};
        this.estimated = {up: 0, down: 0};
        this.lastTotals = null;
        this.lastT = 0;
        this.rate = {proxyUp: 0, proxyDown: 0, directUp: 0, directDown: 0};
        this.hasData = false;
    }

    static isProxy(chains) {
        return Array.isArray(chains) && chains.includes('proxy');
    }

    update(snapshot, nowUs) {
        const dProxy = {up: 0, down: 0};
        const dDirect = {up: 0, down: 0};
        const seen = new Set();
        for (const c of snapshot.connections || []) {
            seen.add(c.id);
            const prev = this.conns.get(c.id) || {up: 0, down: 0};
            const up = Number(c.upload) || 0;
            const down = Number(c.download) || 0;
            const bucket = TrafficTracker.isProxy(c.chains) ? dProxy : dDirect;
            bucket.up += Math.max(0, up - prev.up);
            bucket.down += Math.max(0, down - prev.down);
            this.conns.set(c.id, {up, down});
        }
        for (const id of [...this.conns.keys()]) {
            if (!seen.has(id)) this.conns.delete(id);
        }

        const totUp = Number(snapshot.uploadTotal) || 0;
        const totDown = Number(snapshot.downloadTotal) || 0;
        const base = this.lastTotals ?? {up: 0, down: 0};
        const missUp = Math.max(0, totUp - base.up - dProxy.up - dDirect.up);
        const missDown = Math.max(0, totDown - base.down - dProxy.down - dDirect.down);
        this.lastTotals = {up: totUp, down: totDown};

        for (const dir of ['up', 'down']) {
            const miss = dir === 'up' ? missUp : missDown;
            if (miss <= 0) continue;
            const seenBytes = dProxy[dir] + dDirect[dir];
            const sessBytes = this.proxy[dir] + this.direct[dir];
            let share = 1;
            if (seenBytes > 0) share = dProxy[dir] / seenBytes;
            else if (sessBytes > 0) share = this.proxy[dir] / sessBytes;
            dProxy[dir] += miss * share;
            dDirect[dir] += miss * (1 - share);
            this.estimated[dir] += miss;
        }

        this.proxy.up += dProxy.up; this.proxy.down += dProxy.down;
        this.direct.up += dDirect.up; this.direct.down += dDirect.down;

        const dt = this.lastT ? (nowUs - this.lastT) / 1e6 : 0;
        if (dt > 0) {
            this.rate = {
                proxyUp: dProxy.up / dt, proxyDown: dProxy.down / dt,
                directUp: dDirect.up / dt, directDown: dDirect.down / dt,
            };
        }
        this.lastT = nowUs;
        this.hasData = true;
        return {dProxy, dDirect, rate: this.rate};
    }

    // true when more than 5% of the session was split by estimate
    approximate() {
        const total = this.proxy.up + this.proxy.down + this.direct.up + this.direct.down;
        return total > 0 && (this.estimated.up + this.estimated.down) / total > 0.05;
    }

    summary() {
        const f = formatBytes;
        return `proxied ↓${f(this.proxy.down)} ↑${f(this.proxy.up)}, ` +
            `direct ↓${f(this.direct.down)} ↑${f(this.direct.up)}, ` +
            `of which estimated ↓${f(this.estimated.down)} ↑${f(this.estimated.up)}`;
    }
}

class SubscriptionManager {
    abort() {
        try { this.session.abort(); } catch (e) { /* ignore */ }
    }

    constructor(userAgent = () => 'Qurp') {
        this._userAgent = userAgent;
        this.session = new Soup.Session({timeout: 30});
        // Never route subscription HTTP through the local proxy (avoids hang / HTTP 0)
        try {
            this.session.set_proxy_resolver(
                Gio.SimpleProxyResolver.new(null, null)
            );
        } catch (e) {
            Log.warn(`proxy resolver: ${e.message}`);
        }
    }

    _sessionVia(port) {
        const session = new Soup.Session({timeout: 30});
        try {
            session.set_proxy_resolver(Gio.SimpleProxyResolver.new(`socks5://127.0.0.1:${port}`, null));
        } catch (e) {
            Log.warn(`proxy resolver: ${e.message}`);
        }
        return session;
    }

    // Prefer the direct path; fall back to the running tunnel (or use it only when a kill switch blocks direct traffic).
    async fetchSmart(url, ctx) {
        const via = ctx?.connected ? ctx.port : 0;
        if (via && ctx.ks)
            return await this.fetch(url, via);
        try {
            return await this.fetch(url, 0);
        } catch (e) {
            if (!via) throw e;
            Log.warn(`direct fetch failed (${e.message}); retrying through the tunnel`);
            return await this.fetch(url, via);
        }
    }

    async fetch(url, proxyPort = 0) {
        if (!/^https?:\/\//i.test(url))
            throw new Error('URL must start with http:// or https://');

        let hostLabel = 'subscription';
        try { hostLabel = GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host() || hostLabel; } catch (e) { /* ignore */ }
        Log.info(`Fetching ${hostLabel}${proxyPort ? ' (via tunnel)' : ''}`);
        const session = proxyPort ? this._sessionVia(proxyPort) : this.session;
        const message = Soup.Message.new('GET', url);
        if (!message) throw new Error('invalid URL');
        // many panels (Marzban, Remnawave, 3x-ui...) answer differently depending on the client name
        message.get_request_headers().replace('User-Agent', this._userAgent());
        const bytes = await new Promise((resolve, reject) => {
            session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, null,
                (session, result) => {
                    try {
                        // finish first: a DNS / TLS failure must surface as itself, not as "HTTP 0"
                        const out = session.send_and_read_finish(result);
                        const status = message.get_status
                            ? message.get_status() : message.status_code;
                        if (status < 200 || status >= 300)
                            throw new Error(`HTTP ${status}`);
                        resolve(out);
                    } catch (e) { reject(e); }
                }
            );
        });
        if (bytes.get_size() > 8 * 1024 * 1024)
            throw new Error('subscription is larger than 8 MB');

        let traffic = null;
        const meta = {title: ''};
        try {
            const headers = message.get_response_headers
                ? message.get_response_headers() : message.response_headers;
            const info = headers?.get_one('subscription-userinfo')
                || headers?.get_one('Subscription-Userinfo');
            if (info)
                traffic = this._parseUserinfo(info);
            let title = headers?.get_one('profile-title') || '';
            if (title.toLowerCase().startsWith('base64:')) {
                try { title = decodeBase64(title.slice(7)); } catch (e) { title = ''; }
            }
            meta.title = title.trim().slice(0, 40);
        } catch (e) {
            Log.warn(`userinfo: ${e.message}`);
        }

        let text = new TextDecoder().decode(bytes.get_data()).trim();
        if (!text.includes('://') && !text.startsWith('{')) {
            try { text = decodeBase64(text); } catch (e) {
                Log.warn(`b64: ${e.message}`);
            }
        }

        const servers = [];
        const finish = (s, link) => {
            s.link = link || '';
            s.country = detectCountry(s.rawName);
            s.flag = COUNTRY_INFO[s.country]?.flag ?? '🌐';
            s.display = displayName(s);
            s.id = stableId(s);
            s.latency = null;
            servers.push(s);
        };

        if (text.startsWith('{')) {
            // sing-box JSON profile: keep each outbound as the provider wrote it
            let obj = null;
            try { obj = JSON.parse(text); } catch (e) { Log.warn(`json: ${e.message}`); }
            for (const s of obj && Array.isArray(obj.outbounds) ? this.parseSingboxJson(obj) : [])
                finish(s, '');
        } else if (/^\s*proxies\s*:/m.test(text)) {
            throw keyedError('clash_unsupported');
        } else {
            const links = text.split(/\r?\n|\s+(?=(?:vless|vmess|trojan|ss|hysteria2|hy2):\/\/)/i).map(l => l.trim())
                .filter(l => /^(vless|vmess|trojan|ss|hysteria2|hy2):\/\//i.test(l));
            for (let i = 0; i < links.length; i++) {
                try {
                    const s = this.parse(links[i]);
                    if (s) finish(s, links[i]);
                } catch (e) {
                    Log.warn(`parse #${i}: ${e.message}`);
                }
            }
        }
        if (!servers.length)
            throw new Error('No supported proxy links found');
        const skipped = servers.filter(s => s.unsupported).length;
        Log.info(`Loaded ${servers.length} server(s)${skipped ? `, ${skipped} with an unsupported transport` : ''}`);
        return {servers, traffic, meta};
    }

    parseSingboxJson(obj) {
        const types = new Set(['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2']);
        const out = [];
        for (const o of obj.outbounds) {
            if (!o || !types.has(o.type) || !o.server)
                continue;
            const raw = JSON.parse(JSON.stringify(o));
            delete raw.detour;
            const name = String(o.tag || o.server);
            out.push({
                protocol: o.type,
                uuid: o.uuid,
                password: o.password,
                host: o.server,
                port: Number(o.server_port) || 443,
                rawName: name, name,
                network: normNet(o.transport?.type),
                raw,
                unsupported: '',
            });
        }
        return out;
    }

    _parseUserinfo(header) {
        const parts = {};
        for (const seg of header.split(';')) {
            const [k, v] = seg.trim().split('=');
            if (k && v !== undefined)
                parts[k.trim().toLowerCase()] = v.trim();
        }
        const upload = Number(parts.upload || 0);
        const download = Number(parts.download || 0);
        const total = Number(parts.total || 0);
        const expire = Number(parts.expire || 0);
        const used = upload + download;
        const remaining = total > 0 ? Math.max(0, total - used) : null;
        return {upload, download, total, used, remaining, expire: expire > 0 ? expire : 0};
    }

    parse(link) {
        const protocol = link.slice(0, link.indexOf('://')).toLowerCase();
        if (protocol === 'vless') return this.parseVless(link);
        if (protocol === 'vmess') return this.parseVmess(link);
        if (protocol === 'trojan') return this.parseTrojan(link);
        if (protocol === 'ss') return this.parseShadowsocks(link);
        if (protocol === 'hysteria2' || protocol === 'hy2') return this.parseHysteria2(link);
        return null;
    }

    parseShadowsocks(link) {
        let body = link.slice('ss://'.length);
        let rawName = '';
        const hash = body.indexOf('#');
        if (hash >= 0) {
            try { rawName = safeDecode(body.slice(hash + 1)); } catch (e) { rawName = body.slice(hash + 1); }
            body = body.slice(0, hash);
        }
        let query = '';
        const qi = body.indexOf('?');
        if (qi >= 0) {
            query = body.slice(qi + 1);
            body = body.slice(0, qi);
        }
        body = body.replace(/\/+$/, '');

        let userinfo;
        let hostport;
        const at = body.lastIndexOf('@');
        if (at >= 0) {
            userinfo = safeDecode(body.slice(0, at));
            hostport = body.slice(at + 1);
            if (!userinfo.includes(':'))
                userinfo = decodeBase64(userinfo);
        } else {
            const decoded = decodeBase64(safeDecode(body));
            const dAt = decoded.lastIndexOf('@');
            if (dAt < 0) throw new Error('bad ss link');
            userinfo = decoded.slice(0, dAt);
            hostport = decoded.slice(dAt + 1);
        }
        const colon = userinfo.indexOf(':');
        if (colon < 0) throw new Error('bad ss credentials');
        const m = hostport.match(/^\[?([^\]]+?)\]?:(\d+)$/);
        if (!m) throw new Error('bad ss address');

        const q = parseQuery(query);
        let plugin = '';
        let pluginOpts = '';
        if (q.plugin) {
            const semi = q.plugin.indexOf(';');
            plugin = semi < 0 ? q.plugin : q.plugin.slice(0, semi);
            pluginOpts = semi < 0 ? '' : q.plugin.slice(semi + 1);
        }
        const name = rawName || m[1];
        return {
            protocol: 'shadowsocks',
            method: userinfo.slice(0, colon),
            password: userinfo.slice(colon + 1),
            host: m[1],
            port: Number(m[2]),
            rawName: name, name,
            network: 'tcp',
            unsupported: '',
            plugin, pluginOpts,
        };
    }

    parseHysteria2(link) {
        const url = safeUri(link.replace(/^hy2:\/\//i, 'hysteria2://'));
        const q = parseQuery(url.get_query());
        const fragment = url.get_fragment();
        const rawName = fragment ? safeDecode(fragment) : (url.get_host() || 'Hysteria2');
        const user = safeDecode(url.get_user() || '');
        const pass = url.get_password() ? safeDecode(url.get_password()) : '';
        return {
            protocol: 'hysteria2',
            password: pass ? `${user}:${pass}` : user,
            host: url.get_host(),
            port: url.get_port() > 0 ? url.get_port() : 443,
            rawName, name: rawName,
            network: 'udp',
            unsupported: '',
            sni: q.sni || q.peer || '',
            insecure: isTrue(q.insecure) || isTrue(q.allowInsecure),
            alpn: q.alpn ? q.alpn.split(',').map(x => x.trim()).filter(Boolean) : [],
            obfs: q.obfs || '',
            obfsPassword: q['obfs-password'] || '',
            portRange: q.mport || '',
        };
    }

    parseVless(link) {
        const url = safeUri(link);
        const q = parseQuery(url.get_query());
        const fragment = url.get_fragment();
        const rawName = fragment ? safeDecode(fragment) : (url.get_host() || 'VLESS');
        return {
            protocol: 'vless',
            uuid: safeDecode(url.get_user() || ''),
            host: url.get_host(),
            port: url.get_port() > 0 ? url.get_port() : 443,
            rawName, name: rawName,
            network: normNet(q.type || q.network),
            unsupported: unsupportedReason(normNet(q.type || q.network), q.headerType, q.encryption) ||
                (q.security === 'reality' && !q.pbk ? 'reality-no-key' : ''),
            security: q.security || '',
            flow: q.flow || '',
            sni: q.sni || q.host || '',
            alpn: q.alpn ? q.alpn.split(',').map(x => x.trim()).filter(Boolean) : [],
            path: q.path || '',
            serviceName: q.serviceName || q.service_name || '',
            hostHeader: q.host || '',
            publicKey: q.pbk || q.publicKey || q.public_key || '',
            shortId: q.sid || q.shortId || q.short_id || '',
            fingerprint: q.fp || q.fingerprint || 'chrome',
            packetEncoding: q.packetEncoding || q.packet_encoding || '',
            insecure: isTrue(q.allowInsecure) || isTrue(q.insecure),
        };
    }

    parseVmess(link) {
        const encoded = link.slice('vmess://'.length).split('#')[0];
        const cfg = JSON.parse(decodeBase64(encoded));
        const rawName = cfg.ps || cfg.name || cfg.add || 'VMess';
        const tlsVal = String(cfg.tls || '').toLowerCase();
        return {
            protocol: 'vmess',
            uuid: cfg.id,
            host: cfg.add || cfg.address,
            port: Number(cfg.port || 443),
            rawName, name: rawName,
            network: normNet(cfg.net),
            unsupported: unsupportedReason(normNet(cfg.net), cfg.type, ''),
            security: cfg.scy || cfg.security || 'auto',
            alterId: Number(cfg.aid ?? cfg.alterId ?? 0),
            tlsEnabled: tlsVal === 'tls' || tlsVal === 'reality',
            sni: cfg.sni || cfg.host || '',
            alpn: typeof cfg.alpn === 'string'
                ? cfg.alpn.split(',').map(x => x.trim()).filter(Boolean)
                : (Array.isArray(cfg.alpn) ? cfg.alpn : []),
            path: cfg.path || '',
            hostHeader: cfg.host || cfg.sni || '',
            serviceName: cfg.path || '',
            fingerprint: cfg.fp || 'chrome',
            insecure: isTrue(cfg.allowInsecure) || cfg.verify_cert === false,
        };
    }

    parseTrojan(link) {
        const url = safeUri(link);
        const q = parseQuery(url.get_query());
        const fragment = url.get_fragment();
        const rawName = fragment ? safeDecode(fragment) : (url.get_host() || 'Trojan');
        return {
            protocol: 'trojan',
            // "user:pass@" is split by the URI parser; a trojan password may itself contain ':'
            password: safeDecode(url.get_user() || '') +
                (url.get_password() ? `:${safeDecode(url.get_password())}` : ''),
            host: url.get_host(),
            port: url.get_port() > 0 ? url.get_port() : 443,
            rawName, name: rawName,
            network: normNet(q.type || q.network),
            unsupported: unsupportedReason(normNet(q.type || q.network), q.headerType, ''),
            sni: q.sni || q.host || '',
            alpn: q.alpn ? q.alpn.split(',').map(x => x.trim()).filter(Boolean) : [],
            path: q.path || '',
            serviceName: q.serviceName || q.service_name || '',
            hostHeader: q.host || '',
            fingerprint: q.fp || q.fingerprint || 'chrome',
            insecure: isTrue(q.allowInsecure) || isTrue(q.insecure),
        };
    }
}

function measureLatency(host, port, timeoutMs) {
    return new Promise(resolve => {
        const client = new Gio.SocketClient({
            timeout: Math.ceil(timeoutMs / 1000),
            enable_proxy: false,
        });
        const start = GLib.get_monotonic_time();
        let done = false;
        const finish = ms => {
            if (done) return;
            done = true;
            resolve(ms);
        };
        let source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            source = 0;
            finish(-1);
            return GLib.SOURCE_REMOVE;
        });
        try {
            client.connect_to_host_async(host, port, null, (c, res) => {
                try {
                    const conn = c.connect_to_host_finish(res);
                    const elapsed = Math.round((GLib.get_monotonic_time() - start) / 1000);
                    try { conn.close(null); } catch (e) { /* ignore */ }
                    if (source) { GLib.source_remove(source); source = 0; }
                    finish(elapsed);
                } catch (e) {
                    if (source) { GLib.source_remove(source); source = 0; }
                    finish(-1);
                }
            });
        } catch (e) {
            if (source) { GLib.source_remove(source); source = 0; }
            finish(-1);
        }
    });
}

/* ---------- sing-box ---------- */

class SingBoxManager {
    constructor(settings, onExit) {
        this._settings = settings;
        this._onExit = onExit;
        this.process = null;
        this.apiPort = 0;
        this.apiSecret = '';
        this.ksActive = false;
        this._ready = false;
        this._exited = new WeakSet();
        this._testProc = null;
        this._coreOk = new Set();
        // a crash or log-out while connected leaves the system proxy pointing at a dead port
        if (GLib.file_test(PROXY_BACKUP_FILE, GLib.FileTest.EXISTS))
            this._setGnomeProxy(false);
    }

    _dnsIp(key, fallback) {
        const v = String(this._settings.get_string(key) || '').trim();
        return isIpAddress(v) ? v : fallback;
    }

    get bootstrapIp() {
        return this._dnsIp('dns-bootstrap', '1.1.1.1');
    }

    get remoteDnsIp() {
        return this._dnsIp('dns-remote', '8.8.8.8');
    }

    // true when the user has routing rules the kill switch cannot honour (domain / app based direct routing)
    hasUnhonouredDirectRules() {
        return splitList(this._settings.get_string('routing-direct-domains')).length > 0 ||
            splitList(this._settings.get_string('routing-direct-apps')).length > 0 ||
            this._settings.get_string('routing-preset') === 'ir-bypass';
    }

    // explicit direct IP ranges as CIDR (these can be opened in the firewall)
    directCidrs() {
        return splitList(this._settings.get_string('routing-direct-ips')).map(x =>
            (x.includes('/') ? x : `${x}/${x.includes(':') ? 128 : 32}`));
    }

    get port() {
        return this._settings.get_int('proxy-port') || 2080;
    }

    static helperInstalled() {
        return GLib.file_test(HELPER_PATH, GLib.FileTest.IS_EXECUTABLE);
    }

    /* ----- config ----- */

    _buildOutbound(server) {
        if (server.raw) {
            // sing-box JSON subscription: use the provider's outbound as written
            const o = JSON.parse(JSON.stringify(server.raw));
            o.tag = 'proxy';
            delete o.detour;
            delete o.domain_resolver;
            if (o.tls?.enabled) {
                if (this._settings.get_boolean('tls-skip-verify')) o.tls.insecure = true;
                if (this._settings.get_boolean('tls-fragment') && o.type !== 'hysteria2') o.tls.fragment = true;
            }
            return o;
        }
        const outbound = {
            type: server.protocol,
            tag: 'proxy',
            server: server.host,
            server_port: server.port,
        };
        if (server.protocol === 'vless') {
            outbound.uuid = server.uuid;
            if (server.flow) outbound.flow = server.flow;
            if (server.packetEncoding) outbound.packet_encoding = server.packetEncoding;
        } else if (server.protocol === 'vmess') {
            outbound.uuid = server.uuid;
            outbound.security = server.security || 'auto';
            outbound.alter_id = server.alterId || 0;
        } else if (server.protocol === 'trojan') {
            outbound.password = server.password;
        } else if (server.protocol === 'shadowsocks') {
            outbound.method = server.method;
            outbound.password = server.password;
            if (server.plugin) {
                outbound.plugin = server.plugin;
                if (server.pluginOpts) outbound.plugin_opts = server.pluginOpts;
            }
        } else if (server.protocol === 'hysteria2') {
            outbound.password = server.password;
            if (server.obfs) {
                outbound.obfs = {type: server.obfs, password: server.obfsPassword || ''};
            }
            if (server.portRange) {
                outbound.server_ports = String(server.portRange).split(',')
                    .map(r => r.trim().replace('-', ':')).filter(Boolean);
            }
        }
        this._applyTransport(outbound, server);
        this._applyTls(outbound, server);
        return outbound;
    }

    _directDomains(ks = false) {
        if (ks) return [];
        const list = splitList(this._settings.get_string('routing-direct-domains'));
        if (this._settings.get_string('routing-preset') === 'ir-bypass')
            list.push(...IR_DIRECT);
        return [...new Set(list)];
    }

    _routeRules(tun, ks = false) {
        const S = k => splitList(this._settings.get_string(k));
        const rules = [{action: 'sniff'}];
        if (tun)
            rules.push({protocol: 'dns', action: 'hijack-dns'});

        const block = S('routing-block-domains');
        if (block.length)
            rules.push({domain_suffix: block, action: 'reject'});

        const directDomains = this._directDomains(ks);
        if (directDomains.length)
            rules.push({domain_suffix: directDomains, action: 'route', outbound: 'direct'});

        const cidrs = S('routing-direct-ips').map(x =>
            (x.includes('/') ? x : `${x}/${x.includes(':') ? 128 : 32}`));
        if (cidrs.length)
            rules.push({ip_cidr: cidrs, action: 'route', outbound: 'direct'});

        const apps = ks ? [] : S('routing-direct-apps');
        if (apps.length)
            rules.push({process_name: apps, action: 'route', outbound: 'direct'});

        rules.push({ip_is_private: true, action: 'route', outbound: 'direct'});
        return rules;
    }

    // Keep a pinned server address usable: with the server given as an IP, the TLS name and the
    // HTTP Host header must still be the original host name.
    _pinOutbound(outbound, server, ip) {
        outbound.server = ip;
        if (outbound.tls?.enabled && !outbound.tls.server_name)
            outbound.tls.server_name = server.host;
        const tr = outbound.transport;
        if (tr) {
            const h = server.hostHeader || server.sni || server.host;
            if (tr.type === 'ws' && !tr.headers?.Host)
                tr.headers = {...(tr.headers || {}), Host: h};
            else if (tr.type === 'http' && !tr.host)
                tr.host = [h];
            else if (tr.type === 'httpupgrade' && !tr.host)
                tr.host = h;
        }
    }

    generateConfig(server, opts) {
        const {tun, apiPort, apiSecret, pinIp} = opts;
        const ks = !!opts.ks;
        // TUN hijacks every app's DNS: it must never be answered in the clear
        const dnsLeak = opts.dnsLeak || tun;
        const outbound = this._buildOutbound(server);
        // Proxy outbound resolves its own server name directly, not via the tunnel.
        outbound.domain_resolver = 'bootstrap';
        if (pinIp)
            this._pinOutbound(outbound, server, pinIp);
        const bootstrapDns = {type: 'udp', tag: 'bootstrap', server: this.bootstrapIp};

        const inbounds = [{
            type: 'mixed', tag: 'mixed-in',
            listen: '127.0.0.1', listen_port: this.port,
        }];
        if (tun) {
            inbounds.push({
                type: 'tun', tag: 'tun-in',
                interface_name: TUN_IFACE,
                address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
                auto_route: true,
                strict_route: true,
                stack: 'mixed',
            });
        }

        const config = {
            // "info" logs the destination of every connection (browsing history) into client.log: warn by default
            log: {level: this._settings.get_boolean('core-log-verbose') ? 'info' : 'warn', timestamp: true},
            dns: {
                servers: [bootstrapDns],
                final: 'bootstrap',
                strategy: 'prefer_ipv4',
            },
            inbounds,
            outbounds: [
                outbound,
                {type: 'direct', tag: 'direct', domain_resolver: 'bootstrap'},
            ],
            route: {
                rules: this._routeRules(tun, ks),
                final: 'proxy',
                auto_detect_interface: true,
                default_domain_resolver: 'bootstrap',
            },
        };
        if (!ks && splitList(this._settings.get_string('routing-direct-apps')).length)
            config.route.find_process = true;
        if (apiPort) {
            config.experimental = {
                clash_api: {external_controller: `127.0.0.1:${apiPort}`, secret: apiSecret},
            };
        }

        // DNS leak protection: remote resolvers are reached through the tunnel.
        // In TUN mode, system DNS is hijacked into this resolver as well (so it is always on there);
        // in system-proxy mode OS DNS is not redirected (platform limit).
        if (dnsLeak) {
            const remote = this.remoteDnsIp;
            config.dns.servers = [
                bootstrapDns,
                {
                    type: 'https', tag: 'remote',
                    server: remote, path: '/dns-query',
                    detour: 'proxy', domain_resolver: 'bootstrap',
                },
            ];
            config.dns.final = 'remote';
            config.route.default_domain_resolver = 'remote';
            // names the user sends direct are resolved directly too (a foreign answer would be wrong for them)
            const direct = this._directDomains(ks);
            if (direct.length)
                config.dns.rules = [{domain_suffix: direct, action: 'route', server: 'bootstrap'}];
        }
        return config;
    }

    _applyTransport(outbound, server) {
        if (!['vless', 'vmess', 'trojan'].includes(server.protocol))
            return;
        const network = String(server.network || 'tcp').toLowerCase();
        if (network === 'ws') {
            outbound.transport = {type: 'ws', path: server.path || '/'};
            if (server.hostHeader)
                outbound.transport.headers = {Host: server.hostHeader};
        } else if (network === 'grpc') {
            outbound.transport = {type: 'grpc', service_name: server.serviceName || ''};
        } else if (network === 'http' || network === 'h2') {
            outbound.transport = {type: 'http', path: server.path || '/'};
            if (server.hostHeader)
                outbound.transport.host = [server.hostHeader];
        } else if (network === 'httpupgrade') {
            outbound.transport = {type: 'httpupgrade', path: server.path || '/'};
            if (server.hostHeader)
                outbound.transport.host = server.hostHeader;
        }
    }

    _applyTls(outbound, server) {
        if (server.protocol === 'shadowsocks')
            return;
        const security = String(server.security || '').toLowerCase();
        const isHy2 = server.protocol === 'hysteria2';
        const enabled =
            isHy2 || server.protocol === 'trojan' ||
            security === 'tls' || security === 'reality' ||
            server.tlsEnabled || Boolean(server.publicKey);
        if (!enabled) return;
        outbound.tls = {
            enabled: true,
            server_name: server.sni || server.hostHeader || server.host,
            // certificates are verified unless the link (or the global option) says otherwise
            insecure: this._settings.get_boolean('tls-skip-verify') || server.insecure === true,
        };
        if (isHy2) {
            outbound.tls.alpn = server.alpn?.length ? server.alpn : ['h3'];
            return;
        }
        // split the ClientHello into several records: gets past simple DPI that matches on the SNI
        if (this._settings.get_boolean('tls-fragment'))
            outbound.tls.fragment = true;
        outbound.tls.utls = {enabled: true, fingerprint: server.fingerprint || 'chrome'};
        if (server.alpn?.length) outbound.tls.alpn = server.alpn;
        if ((security === 'reality' || server.publicKey) && server.publicKey) {
            outbound.tls.reality = {
                enabled: true,
                public_key: server.publicKey,
                short_id: server.shortId || '',
            };
        }
    }

    /* ----- process lifecycle ----- */

    _writePrivate(path, text) {
        Gio.File.new_for_path(path).replace_contents(
            text, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null
        );
        GLib.chmod(path, 0o600);
    }

    _spawn(argv) {
        // stderr is read by _watchStderr; stdout is not read by anyone, so do not make it a pipe
        const proc = Gio.Subprocess.new(
            argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE
        );
        proc.wait_async(null, (p, res) => {
            try { p.wait_finish(res); } catch (e) { /* ignore */ }
            this._exited.add(proc);
            if (this.process === proc && this._ready) {
                this.process = null;
                this._ready = false;
                this._setGnomeProxy(false);
                this._onExit?.(p.get_exit_status());
            }
        });
        return proc;
    }

    async _checkTunCaps() {
        try {
            if (GLib.get_user_name() === 'root') return;
            const found = coreBin(true) === CORE_PRIVATE ? CORE_PRIVATE : systemCore();
            if (!found || !GLib.find_program_in_path('getcap')) return;
            const [ok1, real] = await this._run('readlink', '-f', found);
            const [ok2, out] = await this._run('getcap', ok1 ? real.trim() : found);
            if (ok2 && !/cap_net_admin/.test(out))
                throw keyedError('tun_needs_setup');
        } catch (e) {
            if (e.key) throw e;
            // tools missing: skip the pre-check, sing-box will report real errors
        }
    }

    // sing-box must exist and be new enough for the config syntax used here (1.12+)
    async _checkCore(bin = coreBin(false)) {
        if (this._coreOk.has(bin)) return;
        let ok = false, out = '', errOut = '';
        try {
            [ok, out, errOut] = await this._run(bin, 'version');
        } catch (e) {
            // "not found" and "found but cannot be started" (permissions, SELinux, wrong architecture)
            // are different problems: say which one it is
            const msg = String(e.message || e);
            Log.error(`sing-box (${bin}) could not be started: ${msg}`);
            if (/No such file|not found|ENOENT/i.test(msg))
                throw keyedError('core_missing', bin);
            throw keyedError('core_failed', msg.slice(0, 140));
        }
        const m = /sing-box version (\d+)\.(\d+)(?:\.(\d+))?/.exec(out);
        if (m) this._coreVersion = `${m[1]}.${m[2]}${m[3] !== undefined ? `.${m[3]}` : ''}`;
        if (!m && !ok)
            throw keyedError('core_failed', (errOut || out || 'no output').trim().split('\n')[0].slice(0, 140));
        if (m && (Number(m[1]) < MIN_CORE[0] ||
                  (Number(m[1]) === MIN_CORE[0] && Number(m[2]) < MIN_CORE[1])))
            throw keyedError('core_too_old', `${m[1]}.${m[2]} < ${MIN_CORE.join('.')}`);
        this._coreOk.add(bin);
    }

    // Written to the log when the extension starts, so the log itself shows what is missing.
    async logEnvironment() {
        try {
            await this._checkCore();
            Log.info(`sing-box ready: ${coreBin(false)} (version ${this._coreVersion || '?'})`);
        } catch (e) {
            logFailure('error', 'sing-box check', e);
        }
        if (this._settings.get_boolean('kill-switch') && !SingBoxManager.helperInstalled())
            logFailure('warn', 'kill switch', keyedError('helper_missing'));
        if (this._settings.get_string('connection-mode') === 'tun') {
            try { await this._checkTunCaps(); } catch (e) { logFailure('warn', 'TUN mode', e); }
        }
    }

    // The previous core may still be releasing the port for a moment after it was killed.
    async _ensurePortFree() {
        for (let i = 0; i < 8; i++) {
            if (isPortFree(this.port)) return;
            await sleep(200);
        }
        throw keyedError('port_busy', String(this.port));
    }

    async connect(server, opts) {
        // switching servers keeps the system proxy in place (pointing at a closed port) instead of
        // flipping it off, so nothing leaks past the proxy while the new core starts
        const old = this.process;
        this._killProcess();
        try { Gio.File.new_for_path(PROXY_CONFIG_FILE).delete(null); } catch (e) { /* ignore */ }
        if (old)
            await this._waitExit(old, 3000);
        try {
            await this._connectCore(server, opts);
        } catch (e) {
            this._setGnomeProxy(false);
            throw e;
        }
        return true;
    }

    async _connectCore(server, opts) {
        const bin = coreBin(opts.tun);
        await this._checkCore(bin);
        if (opts.tun)
            await this._checkTunCaps();
        await this._ensurePortFree();

        this.apiPort = findFreePort();
        this.apiSecret = randomSecret();
        const config = this.generateConfig(server, {
            ...opts, apiPort: this.apiPort, apiSecret: this.apiSecret,
        });
        GLib.mkdir_with_parents(CONFIG_DIR, 0o700);
        this._writePrivate(PROXY_CONFIG_FILE, JSON.stringify(config, null, 2));
        Log.info(`Config ${server.display} (${server.protocol} ${server.host}:${server.port}${opts.tun ? ', TUN' : ''})`);

        const [ok, stdout, stderr, status] = await this._run(
            bin, 'check', '-c', PROXY_CONFIG_FILE
        );
        if (!ok || status !== 0) {
            const err = (stderr || stdout || 'check failed').trim();
            Log.error(`check: ${err}`);
            throw new Error(err.slice(0, 300));
        }

        const proc = this._spawn([bin, 'run', '-c', PROXY_CONFIG_FILE]);
        this.process = proc;
        this._watchStderr(proc);
        try {
            await this._waitReady(proc, opts.tun ? 10000 : 6000);
        } catch (e) {
            this._killProcess();
            throw e;
        }
        this._ready = true;
        Log.info(`sing-box pid ${proc.get_identifier()}`);
        this._setGnomeProxy(!opts.tun);
    }

    async _waitReady(proc, timeoutMs) {
        const start = GLib.get_monotonic_time();
        while ((GLib.get_monotonic_time() - start) / 1000 < timeoutMs) {
            await sleep(200);
            if (this._exited.has(proc))
                throw keyedError('core_exited');
            if (await measureLatency('127.0.0.1', this.port, 500) >= 0)
                return;
        }
        throw keyedError('core_timeout');
    }

    _watchStderr(proc) {
        try {
            const stream = new Gio.DataInputStream({
                base_stream: proc.get_stderr_pipe(), close_base_stream: true,
            });
            let errors = 0;
            const readLine = () => {
                stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
                    let bytes = null;
                    try {
                        [bytes] = s.read_line_finish(res);
                    } catch (e) {
                        // closed, or an unreadable line: keep going a few times instead of going deaf
                        if (++errors <= 5) readLine();
                        return;
                    }
                    if (bytes === null || bytes === undefined)
                        return;     // end of stream
                    const line = new TextDecoder().decode(bytes);    // lenient: invalid UTF-8 cannot throw
                    const text = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
                    if (text) {
                        if (/error|failed|fatal/i.test(text))
                            Log.error(`sb: ${text}`);
                        else
                            Log.info(`sb: ${text}`);
                    }
                    readLine();
                });
            };
            readLine();
        } catch (e) {
            Log.warn(`stderr: ${e.message}`);
        }
    }

    _killProcess() {
        const proc = this.process;
        this.process = null;
        this._ready = false;
        resetApiSession();
        if (proc)
            this._terminate(proc);
    }

    _terminate(proc) {
        try {
            proc.send_signal(15);
        } catch (e) {
            try { proc.force_exit(); } catch (e2) { /* ignore */ }
            return;
        }
        // sing-box tears down its TUN device and routing rules on SIGTERM; a hard kill can leave them behind
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
            if (!this._exited.has(proc)) {
                try { proc.force_exit(); } catch (e) { /* ignore */ }
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    async _waitExit(proc, ms) {
        const t0 = GLib.get_monotonic_time();
        while (!this._exited.has(proc) && (GLib.get_monotonic_time() - t0) / 1000 < ms)
            await sleep(50);
    }

    disconnect() {
        const had = !!this.process;
        this._killProcess();
        this._setGnomeProxy(false);
        try { Gio.File.new_for_path(PROXY_CONFIG_FILE).delete(null); } catch (e) { /* ignore */ }
        if (had)
            Log.info('Disconnected');
    }

    // The user's own proxy settings are saved before Qurp takes over and put back on disconnect
    // (it used to force "none", wiping a manual or automatic proxy the user already had).
    _setGnomeProxy(enable) {
        const SCHEMAS = {
            http: 'org.gnome.system.proxy.http',
            https: 'org.gnome.system.proxy.https',
            socks: 'org.gnome.system.proxy.socks',
        };
        try {
            const settings = new Gio.Settings({schema_id: 'org.gnome.system.proxy'});
            const hasBackup = GLib.file_test(PROXY_BACKUP_FILE, GLib.FileTest.EXISTS);
            if (enable) {
                if (!hasBackup) {
                    const backup = {mode: settings.get_string('mode')};
                    for (const [k, schema] of Object.entries(SCHEMAS)) {
                        const s = new Gio.Settings({schema_id: schema});
                        backup[k] = {host: s.get_string('host'), port: s.get_int('port')};
                    }
                    GLib.mkdir_with_parents(CONFIG_DIR, 0o700);
                    this._writePrivate(PROXY_BACKUP_FILE, JSON.stringify(backup));
                }
                settings.set_string('mode', 'manual');
                for (const schema of Object.values(SCHEMAS)) {
                    const s = new Gio.Settings({schema_id: schema});
                    s.set_string('host', '127.0.0.1');
                    s.set_int('port', this.port);
                }
            } else if (hasBackup) {
                let backup = null;
                try {
                    const [ok, contents] = Gio.File.new_for_path(PROXY_BACKUP_FILE).load_contents(null);
                    if (ok) backup = JSON.parse(new TextDecoder().decode(contents));
                } catch (e) { /* unreadable: fall back to "none" below */ }
                if (backup) {
                    for (const [k, schema] of Object.entries(SCHEMAS)) {
                        if (!backup[k]) continue;
                        const s = new Gio.Settings({schema_id: schema});
                        s.set_string('host', backup[k].host || '');
                        s.set_int('port', Number(backup[k].port) || 0);
                    }
                    settings.set_string('mode', backup.mode || 'none');
                } else {
                    settings.set_string('mode', 'none');
                }
                try { Gio.File.new_for_path(PROXY_BACKUP_FILE).delete(null); } catch (e) { /* ignore */ }
            }
        } catch (e) {
            Log.warn(`proxy: ${e.message}`);
        }
    }

    /* ----- kill switch (privileged helper) ----- */

    async _helper(...args) {
        const [ok, out, err] = await this._run('pkexec', HELPER_PATH, ...args);
        if (!ok)
            throw keyedError('ks_failed', (err || out).trim().slice(0, 160));
    }

    // cidrs: explicit direct IP ranges from the routing settings, opened in the firewall as well
    async applyKillSwitch(ips, tun, cidrs = []) {
        if (!SingBoxManager.helperInstalled())
            throw keyedError('helper_missing');
        await this._helper('ks-on', ips.join(','), tun ? TUN_IFACE : '-', cidrs.length ? cidrs.join(',') : '-');
        this.ksActive = true;
        // remembered on disk so a crash or log-out cannot leave the firewall rules behind unnoticed
        try {
            GLib.mkdir_with_parents(CONFIG_DIR, 0o700);
            this._writePrivate(KS_FLAG_FILE, String(Date.now()));
        } catch (e) { Log.warn(`ks flag: ${e.message}`); }
    }

    async releaseKillSwitch() {
        if (!this.ksActive) return;
        if (SingBoxManager.helperInstalled())
            await this._helper('ks-off');
        this.ksActive = false;
        try { Gio.File.new_for_path(KS_FLAG_FILE).delete(null); } catch (e) { /* ignore */ }
    }

    // True when rules from an earlier session may still be installed (flag older than the last boot is stale).
    static staleKillSwitch() {
        try {
            if (!GLib.file_test(KS_FLAG_FILE, GLib.FileTest.EXISTS)) return false;
            const info = Gio.File.new_for_path(KS_FLAG_FILE)
                .query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
            const mtime = info.get_modification_date_time().to_unix();
            const [ok, up] = GLib.file_get_contents('/proc/uptime');
            if (ok) {
                const boot = GLib.get_real_time() / 1e6 - parseFloat(new TextDecoder().decode(up));
                if (mtime < boot - 5) {
                    Gio.File.new_for_path(KS_FLAG_FILE).delete(null);
                    return false;
                }
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    /* ----- live stats & real latency (clash API of the core) ----- */

    async fetchConnections() {
        if (!this.apiPort || !this.process) return null;
        const r = await localGet(this.apiPort, '/connections', this.apiSecret, 4);
        if (r.status !== 200) return null;
        return JSON.parse(r.text);
    }

    // Latency of the running tunnel itself (one probe through the active outbound).
    async liveDelay(timeoutMs = 5000) {
        if (!this.apiPort || !this.process) return null;
        const path = `/proxies/proxy/delay?url=${encodeURIComponent(DELAY_URL)}&timeout=${timeoutMs}`;
        const r = await localGet(this.apiPort, path, this.apiSecret, Math.ceil(timeoutMs / 1000) + 3);
        if (r.status !== 200) return -1;
        const d = JSON.parse(r.text);
        return d.delay > 0 ? d.delay : -1;
    }

    cancelMeasure() {
        const proc = this._testProc;
        this._testProc = null;
        if (proc) {
            try { proc.force_exit(); } catch (e) { /* ignore */ }
        }
    }

    _testConfig(servers, port, secret) {
        const outbounds = servers.map((s, i) => {
            const o = this._buildOutbound(s);
            o.tag = `s${i}`;
            o.domain_resolver = 'bootstrap';
            return o;
        });
        outbounds.push({type: 'direct', tag: 'direct', domain_resolver: 'bootstrap'});
        return {
            log: {level: 'error'},
            dns: {
                servers: [{type: 'udp', tag: 'bootstrap', server: this.bootstrapIp}],
                final: 'bootstrap', strategy: 'prefer_ipv4',
            },
            inbounds: [],
            outbounds,
            route: {final: 'direct', auto_detect_interface: true, default_domain_resolver: 'bootstrap'},
            experimental: {clash_api: {external_controller: `127.0.0.1:${port}`, secret}},
        };
    }

    async _probe(port, secret, tag, timeoutMs) {
        const t0 = GLib.get_monotonic_time();
        try {
            const path = `/proxies/${tag}/delay?url=${encodeURIComponent(DELAY_URL)}&timeout=${timeoutMs}`;
            const r = await localGet(port, path, secret, Math.ceil(timeoutMs / 1000) + 3);
            if (r.status === 200) {
                const d = JSON.parse(r.text);
                if (d.delay > 0) return {ok: true, ms: d.delay};
            }
            const elapsed = (GLib.get_monotonic_time() - t0) / 1000;
            return {ok: false, kind: (r.status === 504 || elapsed >= timeoutMs * 0.9) ? 'timeout' : 'error'};
        } catch (e) {
            return {ok: false, kind: 'error'};
        }
    }

    /*
     * Measure every server through its own outbound in a throw-away core.
     * Servers are processed in batches; results stream out through onResult.
     * opts: {probes, timeoutMs, onResult(server, {ms, state}), signal: {cancelled}}
     */
    async measureDelays(servers, opts) {
        if (this._measuring)
            throw new Error('a measurement is already running');
        this._measuring = true;
        try {
            return await this._measureDelays(servers, opts);
        } finally {
            this._measuring = false;
        }
    }

    async _measureDelays(servers, opts) {
        await this._checkCore();
        const BATCH = 100;
        for (let off = 0; off < servers.length; off += BATCH) {
            if (opts.signal?.cancelled) break;
            await this._measureBatch(servers.slice(off, off + BATCH), opts);
        }
    }

    async _measureBatch(batch, {probes = 3, timeoutMs = 5000, onResult, signal}) {
        const port = findFreePort();
        const secret = randomSecret();
        const alive = batch.slice();
        GLib.mkdir_with_parents(CONFIG_DIR, 0o700);
        const file = GLib.build_filenamev([CONFIG_DIR, 'test-config.json']);
        try {
            // `check` names the first broken outbound; drop it and try again.
            for (let attempt = 0; ; attempt++) {
                this._writePrivate(file, JSON.stringify(this._testConfig(alive, port, secret)));
                const [ok, so, se, st] = await this._run(coreBin(false), 'check', '-c', file);
                if (ok && st === 0) break;
                const msg = (se || so || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
                const m = msg.match(/outbound\[(\d+)\]/);
                if (!m || attempt >= 25 || Number(m[1]) >= alive.length)
                    throw keyedError('real_ping_failed', msg.slice(0, 160));
                const [bad] = alive.splice(Number(m[1]), 1);
                onResult?.(bad, {ms: -1, state: 'error'});
                if (!alive.length) return;
            }

            const proc = Gio.Subprocess.new(
                [coreBin(false), 'run', '-c', file],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            this._testProc = proc;
            let up = false;
            // poll faster so we do not burn ~1–2 s waiting on a core that is already up
            for (let i = 0; i < 40 && !up && !signal?.cancelled; i++) {
                await sleep(i === 0 ? 50 : 80);
                try { up = (await localGet(port, '/version', secret, 2)).status === 200; } catch (e) { /* retry */ }
            }
            if (signal?.cancelled) return;
            if (!up)
                throw keyedError('real_ping_failed', 'core API did not start');

            let next = 0;
            const worker = async () => {
                while (next < alive.length && !signal?.cancelled) {
                    const i = next++;
                    const samples = [];
                    for (let p = 0; p < probes && !signal?.cancelled; p++) {
                        const sample = await this._probe(port, secret, `s${i}`, timeoutMs);
                        samples.push(sample);
                        const n = samples.length;
                        // two failures in a row → give up on this server early
                        if (n >= 2 && !samples[n - 1].ok && !samples[n - 2].ok) break;
                        // one solid success is enough when only a single probe was requested
                        if (probes <= 1 && sample.ok) break;
                    }
                    if (samples.length && !signal?.cancelled)
                        onResult?.(alive[i], aggregateProbes(samples));
                }
            };
            // more parallel probes = faster full list; capped so one slow core is not flooded
            const workers = Math.min(12, Math.max(4, alive.length));
            await Promise.all(Array.from({length: workers}, () => worker()));
        } finally {
            this.cancelMeasure();
            try { Gio.File.new_for_path(file).delete(null); } catch (e) { /* ignore */ }
        }
    }

    async _run(...argv) {
        const proc = Gio.Subprocess.new(
            argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );
        const result = await new Promise((resolve, reject) => {
            proc.communicate_utf8_async(null, null, (p, res) => {
                try { resolve(p.communicate_utf8_finish(res)); }
                catch (e) { reject(e); }
            });
        });
        return [proc.get_successful(), result[1] || '', result[2] || '', proc.get_exit_status()];
    }
}

/* ---------- Exit IP ---------- */

const IP_ENDPOINTS = [
    ['https://api.ipify.org?format=json', 'json'],
    ['https://ipv4.icanhazip.com', 'text'],
    ['https://checkip.amazonaws.com', 'text'],
    ['https://ifconfig.me/ip', 'text'],
];
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{3,39})$/i;

async function fetchIpFrom(port, url, kind, cancellable) {
    const session = new Soup.Session({timeout: 6, idle_timeout: 6});
    try {
        session.set_proxy_resolver(Gio.SimpleProxyResolver.new(`socks5://127.0.0.1:${port}`, null));
    } catch (e) {
        throw new Error(`proxy resolver: ${e.message}`);
    }
    const message = Soup.Message.new('GET', url);
        if (!message) throw new Error('invalid URL');
    message.get_request_headers().append('Cache-Control', 'no-cache');
    const bytes = await new Promise((resolve, reject) => {
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
            try {
                const out = s.send_and_read_finish(res);
                const status = message.get_status();
                if (status < 200 || status >= 300)
                    throw new Error(`HTTP ${status}`);
                resolve(out);
            } catch (e) { session.abort(); reject(e); }
        });
    });
    session.abort();
    const raw = new TextDecoder().decode(bytes.get_data()).trim();
    const ip = kind === 'json' ? String(JSON.parse(raw).ip || '').trim() : raw;
    if (!IP_RE.test(ip))
        throw new Error('not an IP address');
    return ip;
}

// Try every endpoint through the tunnel; the first valid answer wins.
async function fetchExitIp(port, cancellable) {
    let lastErr = null;
    for (const [url, kind] of IP_ENDPOINTS) {
        if (cancellable?.is_cancelled())
            throw new Error('cancelled');
        try {
            return await fetchIpFrom(port, url, kind, cancellable);
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr ?? new Error('no endpoint answered');
}

/* ---------- UI ---------- */

// ---- Version check (GitHub releases) -------------------------------------------------
function parseRepo(url) {
    const m = /^https:\/\/github\.com\/([^\/\s]+)(?:\/([^\/\s#?]+))?/.exec(url || '');
    if (!m)
        return null;
    return `${m[1]}/${(m[2] || 'qurp').replace(/\.git$/, '')}`;
}

function parseVer(v) {
    return String(v).replace(/^[^\d]*/, '').split(/[^\d]+/).filter(Boolean).map(Number);
}

function isNewer(a, b) {
    const x = parseVer(a), y = parseVer(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d)
            return d > 0;
    }
    return false;
}

async function ghGetJson(url, cancellable) {
    const session = new Soup.Session({timeout: 10, idle_timeout: 10});
    const message = Soup.Message.new('GET', url);
        if (!message) throw new Error('invalid URL');
    const h = message.get_request_headers();
    h.append('User-Agent', 'qurp-gnome-extension');
    h.append('Accept', 'application/vnd.github+json');
    try {
        const bytes = await new Promise((resolve, reject) => {
            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
                try { resolve(s.send_and_read_finish(res)); } catch (e) { reject(e); }
            });
        });
        const status = message.get_status();
        let json = null;
        if (status === 200)
            json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        return {status, json};
    } finally {
        session.abort();
    }
}

async function fetchLatestTag(repo, cancellable) {
    let r = await ghGetJson(`https://api.github.com/repos/${repo}/releases/latest`, cancellable);
    if (r.status === 200 && r.json?.tag_name)
        return String(r.json.tag_name);
    if (r.status === 404) {
        r = await ghGetJson(`https://api.github.com/repos/${repo}/tags?per_page=20`, cancellable);
        if (r.status === 200 && Array.isArray(r.json) && r.json.length) {
            let best = String(r.json[0].name);
            for (const t of r.json)
                if (isNewer(t.name, best))
                    best = String(t.name);
            return best;
        }
    }
    throw new Error(`HTTP ${r.status}`);
}

const RowItem = GObject.registerClass(
class RowItem extends PopupMenu.PopupBaseMenuItem {
    _init(child) {
        super._init({activate: false, can_focus: false, reactive: false});
        this.add_child(child);
    }
});

const ProxyToggle = GObject.registerClass(
class ProxyToggle extends QuickSettings.QuickMenuToggle {
    _init(extension) {
        super._init({
            title: 'Qurp',
            subtitle: 'Off',
            iconName: 'network-vpn-symbolic',
            toggleMode: true,
        });

        this._ext = extension;
        this._settings = extension.getSettings();
        this._i18n = extension._i18n;
        this._subMgr = new SubscriptionManager(() => this._userAgent());
        this._singbox = new SingBoxManager(this._settings, st => this._onCoreExit(st));
        this._servers = [];
        this._subs = [];
        this._selected = null;
        this._connectedServer = null;
        this._connecting = false;
        this._pinging = false;
        this._connected = false;
        this._exitIpSource = 0;
        this._exitIpGen = 0;
        this._exitIpCancel = null;
        this._writingSubs = false;
        this._importing = false;
        this._reloading = false;
        this._importGen = 0;
        this._blocked = false;
        this._activeTun = false;
        this._rate = null;
        this._lastTotals = null;
        this._statsSource = 0;
        this._statsBusy = false;
        this._autoUpdateSource = 0;
        this._autoUpdating = false;
        this._lastAutoTry = 0;
        this._query = '';
        this._queryTimer = 0;
        this._rowRefs = new Map();
        this._expanded = new Set(this._settings.get_strv('expanded-subs'));
        this._pinned = new Set(this._settings.get_strv('pinned-servers'));
        this._tracker = new TrafficTracker();
        this._usage = loadUsage();
        this._usageDirty = false;
        this._liveMs = null;
        this._tickCount = 0;
        this._pingSignal = null;
        this._liveFails = 0;
        this._lastLive = 0;
        this._skip = 0;
        this._rcGen = 0;
        this._reconnecting = false;
        this._netMon = null;
        this._netId = 0;
        this._netTimer = 0;

        this.menu.setHeader('network-vpn-symbolic', 'Qurp', this.t('proxy_client'));
        this._watchFit();
        this.menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                return;
            this._queueFit(40);
            this._queueFit(420);        // after the open animation has settled
            this._updateStatusUi();     // live numbers are only refreshed while the menu is open
        });
        this._buildUi();
        this._settingsSig = this._settings.connect('changed', (_s, key) => this._onSettingsChanged(key));
        this.connect('clicked', () => this._onQuickToggle());
        // firewall rules left by an earlier session (crash, log-out) keep traffic blocked: show it
        if (SingBoxManager.staleKillSwitch()) {
            this._singbox.ksActive = true;
            this._blocked = true;
            Log.warn('kill switch rules from an earlier session may still be active');
        }
        this._loadSubs(!this._blocked);
        this._applyStrings();
        this._startAutoUpdate();
        this._startVersionCheck();
        this._watchNetwork();
    }

    _userAgent() {
        const custom = String(this._settings.get_string('sub-user-agent') || '').trim();
        return custom || `Qurp/${this._curVersion || '1'} (sing-box; v2rayN-compatible)`;
    }

    // ---- Right-to-left layout (Persian): mirrors the panel when that language is chosen ----
    _applyDirection(root) {
        const dir = this._i18n.isRtl ? Clutter.TextDirection.RTL : Clutter.TextDirection.LTR;
        const walk = actor => {
            try { actor.set_text_direction(dir); } catch (e) { return; }
            for (const c of actor.get_children?.() ?? [])
                walk(c);
        };
        walk(root ?? this.menu.box);
    }

    // ---- Reconnect: core crash, dead tunnel (watchdog) or a network change ----
    async _reconnect(server) {
        if (!server || this._reconnecting || this._connecting || this._destroyed)
            return;
        this._reconnecting = true;
        const gen = ++this._rcGen;
        try {
            for (let i = 0; i < 3; i++) {
                this._setTransient(this.t('reconnecting'));
                await sleep(1500 * (i + 1));
                if (gen !== this._rcGen || this._destroyed)
                    return;                 // the user disconnected or chose another server meanwhile
                await this._connectServer(server, {auto: true});
                if (this._connected)
                    return;
            }
            this._setTransient(this.t('reconnect_failed'));
        } catch (e) {
            Log.warn(`reconnect: ${e.message}`);
        } finally {
            this._reconnecting = false;
        }
    }

    _watchNetwork() {
        try {
            this._netMon = Gio.NetworkMonitor.get_default();
            this._netId = this._netMon.connect('network-changed', () => {
                if (this._netTimer)
                    GLib.source_remove(this._netTimer);
                this._netTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
                    this._netTimer = 0;
                    this._probeAfterNetworkChange();
                    return GLib.SOURCE_REMOVE;
                });
            });
        } catch (e) {
            Log.warn(`network monitor: ${e.message}`);
        }
    }

    async _probeAfterNetworkChange() {
        if (!this._connected || this._connecting || this._reconnecting || this._destroyed ||
            !this._netMon?.network_available || !this._settings.get_boolean('auto-reconnect'))
            return;
        let ms = -1;
        try { ms = (await this._singbox.liveDelay(4000)) ?? -1; } catch (e) { /* ignore */ }
        if (ms > 0 || !this._connected) {
            this._liveFails = 0;
            return;
        }
        Log.warn('network changed and the tunnel does not answer; reconnecting');
        this._reconnect(this._connectedServer);
    }

    t(key, vars) {
        return this._i18n.t(key, vars);
    }

    // ---- Version chip: checked twice a day, green = up to date, red = update available ----
    _versionState() {
        const latest = this._settings.get_string('latest-version');
        if (!latest)
            return 'n';
        return isNewer(latest, this._curVersion) ? 'r' : 'g';
    }

    _updateVersionChip() {
        if (!this._verChip)
            return;
        const st = this._versionState();
        const latest = this._settings.get_string('latest-version');
        const cur = `v${this._curVersion}`;
        this._verChip.label = st === 'r' ? `● ${cur} → ${latest.startsWith('v') ? latest : `v${latest}`}` : `● ${cur}`;
        this._verChip.style_class = `qurp-ver-chip ${st}`;
        this._verChip.accessible_name = st === 'r' ? this.t('update_available')
            : (st === 'g' ? this.t('up_to_date') : this.t('version_pending'));
    }

    _startVersionCheck() {
        this._vcCancel = new Gio.Cancellable();
        this._vcKick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
            this._vcKick = 0;
            this._checkVersion(false);
            return GLib.SOURCE_REMOVE;
        });
        // wake-up every 30 min; a real request only goes out when 12 h have passed
        this._vcSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1800, () => {
            this._checkVersion(false);
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _checkVersion(force) {
        if (this._vcBusy || this._destroyed || !this._repo)
            return;
        const now = Math.floor(Date.now() / 1000);
        // the periodic check can be switched off; clicking the chip still checks on demand
        if (!force && !this._settings.get_boolean('check-updates'))
            return;
        if (!force && now - this._settings.get_int64('last-version-check') < VERSION_CHECK_SECS)
            return;
        this._vcBusy = true;
        try {
            const tag = await fetchLatestTag(this._repo, this._vcCancel);
            if (this._destroyed)
                return;
            this._settings.set_string('latest-version', tag);
            this._settings.set_int64('last-version-check', now);
        } catch (e) {
            if (!this._destroyed)
                Log.warn(`version check: ${e.message}`);
        } finally {
            this._vcBusy = false;
            if (!this._destroyed)
                this._updateVersionChip();
        }
    }

    _onVersionChip() {
        if (this._versionState() === 'r' && this._repo) {
            this.menu.close();
            try { Gio.AppInfo.launch_default_for_uri(`https://github.com/${this._repo}/releases/latest`, null); }
            catch (e) { Log.warn(`open url: ${e.message}`); }
        } else {
            this._checkVersion(true);
        }
    }

    _buildFooter() {
        const CENTER = Clutter.ActorAlign.CENTER;
        const meta = this._ext.metadata ?? {};
        this._curVersion = meta['version-name'] ?? String(meta.version ?? '');
        this._repo = parseRepo(meta.url);

        const row = new St.BoxLayout({vertical: false, x_expand: true, style_class: 'qurp-footer'});
        this._verChip = new St.Button({style_class: 'qurp-ver-chip n', can_focus: true, y_align: CENTER});
        this._verChip.connect('clicked', () => this._onVersionChip());
        row.add_child(this._verChip);

        if (this._repo) {
            const gh = new St.Button({
                style_class: 'qurp-icon-btn qurp-gh-btn', can_focus: true, y_align: CENTER,
                accessible_name: 'GitHub',
                child: new St.Icon({icon_name: 'web-browser-symbolic', icon_size: 15}),
            });
            attachHoverTip(gh, 'GitHub');
            gh.connect('clicked', () => {
                this.menu.close();
                try { Gio.AppInfo.launch_default_for_uri(`https://github.com/${this._repo}`, null); }
                catch (e) { Log.warn(`open url: ${e.message}`); }
            });
            row.add_child(gh);
        }
        row.add_child(new St.Widget({x_expand: true}));

        const inner = new St.BoxLayout({vertical: false, style_class: 'qurp-tool-inner'});
        inner.add_child(new St.Icon({icon_name: 'emblem-system-symbolic', icon_size: 14}));
        this._settingsLabel = new St.Label({text: 'Settings', y_align: CENTER});
        inner.add_child(this._settingsLabel);
        const setBtn = new St.Button({style_class: 'qurp-settings-btn', can_focus: true, child: inner});
        setBtn.connect('clicked', () => {
            this.menu.close();
            try { this._ext.openPreferences(); } catch (e) { Log.warn(`prefs: ${e.message}`); }
        });
        row.add_child(setBtn);
        this.menu.addMenuItem(new RowItem(row));
        this._updateVersionChip();
    }

    _buildUi() {
        const CENTER = Clutter.ActorAlign.CENTER;

        // Hero card: current state at a glance
        this._statusTitle = new St.Label({
            text: '', style_class: 'qurp-status-title', x_expand: true,
        });
        this._statusSub = new St.Label({
            text: '', style_class: 'qurp-status-sub', x_expand: true,
        });
        this._badge = new St.Label({
            text: '', style_class: 'qurp-badge offline', y_align: CENTER,
        });
        const headCol = new St.BoxLayout({vertical: true, x_expand: true, y_align: CENTER});
        headCol.add_child(this._statusTitle);
        headCol.add_child(this._statusSub);

        this._heroGlyph = new St.Icon({
            icon_name: 'network-vpn-disabled-symbolic',
            icon_size: 18,
            style_class: 'qurp-hero-glyph',
            x_align: CENTER, y_align: CENTER,
        });
        const heroIcon = new St.Bin({
            style_class: 'qurp-hero-icon', child: this._heroGlyph, y_align: CENTER,
        });
        this._hero = new St.BoxLayout({
            vertical: false, x_expand: true, style_class: 'qurp-hero offline',
        });
        this._hero.add_child(heroIcon);
        this._hero.add_child(headCol);
        // (connect button + exit IP are added below, inside the same card)

        this._metaLabel = new St.Label({text: '', style_class: 'qurp-meta', x_expand: true, visible: false});
        this._metaLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);

        // Exit IP (click the address to copy it) — small line under the status
        this._exitIpLabel = new St.Label({text: '—', style_class: 'qurp-exit-ip-value'});
        this._exitIpBtn = new St.Button({
            style_class: 'qurp-ip-btn', can_focus: true, child: this._exitIpLabel,
        });
        attachHoverTip(this._exitIpBtn, () => this.t('copy'));
        this._exitIpBtn.connect('clicked', () => this._copyExitIp());
        this._exitRow = new St.BoxLayout({vertical: false, style_class: 'qurp-exit-row dim'});
        this._exitIpCaption = new St.Label({text: 'Exit IP', style_class: 'qurp-exit-ip-caption'});  // detached
        this._exitRow.add_child(this._exitIpBtn);
        this._exitRefreshBtn = new St.Button({
            style_class: 'qurp-icon-btn', can_focus: true,
            accessible_name: 'Refresh exit IP',
        });
        this._exitRefreshBtn.child = new St.Icon({
            icon_name: 'view-refresh-symbolic', icon_size: 12,
        });
        attachHoverTip(this._exitRefreshBtn, () => this.t('exit_ip_check'));
        this._exitRefreshBtn.connect('clicked', () => this._checkExitIp());
        this._exitRow.add_child(this._exitRefreshBtn);
        headCol.add_child(this._exitRow);

        // Connect button (right side of the hero card)
        this._connectBtn = new St.Button({
            label: 'Connect', style_class: 'qurp-connect-btn idle',
            can_focus: true, y_align: CENTER,
        });
        this._connectBtn.connect('clicked', () => this._onConnectButton());
        this._hero.add_child(this._connectBtn);
        this.menu.addMenuItem(new RowItem(this._hero));

        // Search + icon-only tools on one row
        this._bestBtn = this._iconBtn('media-seek-forward-symbolic', 'Best', () => this._connectBest());
        this._pingBtn = this._iconBtn('network-transmit-receive-symbolic', 'Ping', () => this._pingAll());
        this._updateBtn = this._iconBtn('view-refresh-symbolic', 'Update', () => this._reloadAll());
        this._importBtn = this._iconBtn('edit-paste-symbolic', 'Import', () => this._importClipboard());

        // Traffic text is no longer shown (label kept off-screen so its updater stays harmless)
        this._trafficLabel = new St.Label({text: ''});
        this._focusRows = [];

        this._searchEntry = new St.Entry({
            style_class: 'qurp-search', hint_text: 'Search', can_focus: true, x_expand: true,
        });
        this._searchEntry.set_primary_icon(new St.Icon({
            icon_name: 'edit-find-symbolic', style_class: 'qurp-search-icon',
        }));
        this._searchEntry.clutter_text.connect('text-changed', () => {
            if (this._queryTimer)
                GLib.source_remove(this._queryTimer);
            this._queryTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
                this._queryTimer = 0;
                this._query = this._searchEntry.get_text().trim().toLowerCase();
                this._rebuildServerList();
                return GLib.SOURCE_REMOVE;
            });
        });
        const searchRow = new St.BoxLayout({vertical: false, x_expand: true, style_class: 'qurp-search-row'});
        searchRow.add_child(this._searchEntry);
        for (const b of [this._bestBtn, this._pingBtn, this._updateBtn, this._importBtn])
            searchRow.add_child(b);
        const searchItem = new RowItem(searchRow);
        this.menu.addMenuItem(searchItem);
        this._focusRows.push(searchItem);

        // Server list
        this._scrollView = new St.ScrollView({
            style_class: 'qurp-server-scroll',
            overlay_scrollbars: true,
            x_expand: true, y_expand: true,
        });
        if (this._scrollView.set_policy)
            this._scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._scrollView.style = `max-height: ${SERVER_LIST_MAX_HEIGHT}px;`;
        this._serverBox = new St.BoxLayout({vertical: true, x_expand: true});
        if (this._scrollView.set_child)
            this._scrollView.set_child(this._serverBox);
        else
            this._scrollView.add_child(this._serverBox);
        this.menu.addMenuItem(new RowItem(this._scrollView));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._buildFooter();
    }

    // ---- Keep the whole panel on screen -----------------------------------------------
    // Closed loop: measure how far the Quick Settings popup (with the Qurp menu inside it)
    // sticks out below the work area, then shrink or grow the server list by exactly that
    // much. It runs whenever the popup's size changes, so moving the Qurp tile, tiles
    // appearing/disappearing, expanding a subscription or a monitor change all re-fit.
    _queueFit(ms = 40) {
        this._fitTimers ??= new Set();
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._fitTimers.delete(id);
            this._fitServerList(0);
            return GLib.SOURCE_REMOVE;
        });
        this._fitTimers.add(id);
    }

    _clearFit() {
        for (const id of this._fitTimers ?? [])
            GLib.source_remove(id);
        this._fitTimers = null;
        if (this._fitBox && this._fitSig)
            this._fitBox.disconnect(this._fitSig);
        this._fitBox = null;
        this._fitSig = 0;
        if (this._monSignal) {
            Main.layoutManager.disconnect(this._monSignal);
            this._monSignal = 0;
        }
    }

    _watchFit() {
        const box = Main.panel.statusArea.quickSettings?.menu?.box;
        if (!box || this._fitBox)
            return;
        this._fitBox = box;
        let last = 0;
        this._fitSig = box.connect('notify::allocation', () => {
            const h = Math.round(box.get_height());
            if (h === last)
                return;
            last = h;
            this._queueFit(60);
        });
        this._monSignal = Main.layoutManager.connect('monitors-changed', () => this._queueFit());
    }

    _fitServerList(pass) {
        try {
            const qs = Main.panel.statusArea.quickSettings;
            const box = qs?.menu?.box;
            if (!box || !this._scrollView || !qs.menu.isOpen || !this._serverBox.get_stage())
                return;
            const mon = Main.layoutManager.findMonitorForActor?.(box) ?? Main.layoutManager.primaryMonitor;
            const work = Main.layoutManager.getWorkAreaForMonitor(mon.index);
            const limit = work.y + work.height - 10;
            const rect = box.get_transformed_extents();
            const bottom = rect.get_y() + rect.get_height() + 12;
            // the popup may be clamped by the shell; compare natural and allocated size too
            const clipped = box.get_preferred_height(-1)[1] - box.get_height();
            const overflow = Math.max(bottom - limit, clipped);

            const viewH = this._scrollView.get_height();
            const content = this._serverBox.get_preferred_height(-1)[1];
            const cur = this._fitHeight ?? SERVER_LIST_MAX_HEIGHT;
            let next = cur;
            if (overflow > 1)
                next = viewH - overflow;                          // too tall: shrink
            else if (overflow < -6 && content > viewH + 1)
                next = viewH - overflow;                          // room to spare: grow
            next = Math.round(Math.max(SERVER_LIST_MIN_HEIGHT, Math.min(next, 900)));
            if (next !== cur) {
                this._fitHeight = next;
                this._scrollView.style = `max-height: ${next}px;`;
                if (pass < 3) {
                    const tid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 70, () => {
                        this._fitTimers?.delete(tid);
                        this._fitServerList(pass + 1);
                        return GLib.SOURCE_REMOVE;
                    });
                    this._fitTimers?.add(tid);
                }
            }
        } catch (e) {
            Log.warn(`fit list: ${e.message}`);
        }
    }

    _iconBtn(icon, label, fn) {
        const b = new St.Button({
            style_class: 'qurp-tool-btn qurp-icon-tool', can_focus: true, accessible_name: label,
            child: new St.Icon({icon_name: icon, icon_size: 15}),
        });
        b._label = new St.Label({text: label});   // detached: drives accessible_name + hover tip
        const syncName = () => { b.accessible_name = b._label.text || ''; };
        syncName();
        b._label.connect('notify::text', syncName);
        attachHoverTip(b, () => b._label.text || '');
        b.connect('clicked', fn);
        return b;
    }

    _copyExitIp() {
        const v = this._exitIpLabel.text;
        if (!/^[0-9a-f:.]{3,}$/i.test(v)) {
            if (this._connected && v === this.t('verify_failed'))
                this._checkExitIp();
            return;
        }
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, v);
        this._setTransient(this.t('copied'));
    }

    _applyStrings() {
        const t = k => this.t(k);
        this._bestBtn._label.text = t('best');
        this._searchEntry.hint_text = t('search');
        this._importBtn._label.text = t('import');
        this._updateBtn._label.text = t('update');
        this._pingBtn._label.text = this._pinging ? t('cancel') : t('ping');
        this._exitIpCaption.text = t('exit_ip');
        this._settingsLabel.text = t('settings');
        if (this._exitRefreshBtn)
            this._exitRefreshBtn.accessible_name = t('exit_ip_check');
        if (this._exitIpBtn)
            this._exitIpBtn.accessible_name = t('copy');
        this._updateStatusUi();
        this._updateConnectButton();
        this._updateTrafficLabel();
        this._applyDirection();
    }

    _onSettingsChanged(key) {
        if (key === 'language') {
            this._i18n.load(this._settings.get_string('language'));
            this._applyStrings();
            this._rebuildServerList();
        } else if (key === 'subscriptions') {
            if (this._writingSubs)
                return;
            this._mergeSubsFromSettings();
        } else if (key === 'update-request') {
            this._handleUpdateRequest();
        } else if (key === 'ping-stale-minutes') {
            this._rebuildServerList();
        }
    }

    _readMetaSubs() {
        try {
            const arr = JSON.parse(this._settings.get_string('subscriptions') || '[]');
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            return [];
        }
    }

    _readCache() {
        try {
            const [ok, contents] = Gio.File.new_for_path(CACHE_FILE).load_contents(null);
            if (!ok) return {};
            const obj = JSON.parse(new TextDecoder().decode(contents));
            return obj && typeof obj === 'object' ? obj : {};
        } catch (e) {
            return {};
        }
    }

    _writeCache() {
        GLib.mkdir_with_parents(CONFIG_DIR, 0o700);
        const cache = {};
        for (const sub of this._subs) {
            cache[sub.id] = {
                servers: sub.servers || [],
                traffic: sub.traffic ?? null,
                updatedAt: sub.updatedAt ?? null,
                error: sub.error ?? null,
            };
        }
        try {
            Gio.File.new_for_path(CACHE_FILE).replace_contents(
                JSON.stringify(cache), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null
            );
        } catch (e) {
            Log.warn(`cache write: ${e.message}`);
        }
    }

    _migrateIds(idMap) {
        if (!idMap.size) return;
        let changed = false;
        for (const [oldId, newId] of idMap) {
            if (this._pinned.has(oldId)) {
                this._pinned.delete(oldId);
                this._pinned.add(newId);
                changed = true;
            }
        }
        if (changed)
            this._settings.set_strv('pinned-servers', [...this._pinned]);
        const last = this._settings.get_string('last-server-id');
        if (idMap.has(last))
            this._settings.set_string('last-server-id', idMap.get(last));
    }

    // usage of subscriptions that no longer exist
    _pruneUsage() {
        let dropped = false;
        for (const id of Object.keys(this._usage ?? {})) {
            if (!this._subs.some(sub => sub.id === id)) {
                delete this._usage[id];
                dropped = true;
            }
        }
        if (dropped)
            this._usageDirty = true;
    }

    _loadSubs(autoFetch = true) {
        const meta = this._readMetaSubs();
        const cache = this._readCache();
        const idMap = new Map();     // old-format id -> new id (pins and the last server survive the change)
        this._subs = meta.map(m => {
            const c = cache[m.id] || {};
            // migrate: old installs may still embed servers in GSettings
            const servers = (c.servers && c.servers.length)
                ? c.servers
                : (m.servers || []);
            for (const s of servers) {
                const oldId = s.id;
                s.id = stableId(s);
                if (oldId && oldId !== s.id) idMap.set(oldId, s.id);
                if (!s.display) s.display = displayName(s);
            }
            return {
                id: m.id,
                name: m.name || 'Sub',
                url: m.url,
                enabled: m.enabled !== false,
                servers,
                traffic: c.traffic ?? m.traffic ?? null,
                updatedAt: c.updatedAt ?? m.updatedAt ?? null,
                error: c.error ?? null,
            };
        });
        this._migrateIds(idMap);
        this._pruneUsage();
        {
            const activeSubs = this._subs.filter(s => s.enabled !== false);
            const keep = [...this._expanded].filter(id => activeSubs.some(s => s.id === id));
            this._expanded = new Set(keep.slice(0, 1));
            if (!this._expanded.size && activeSubs.length === 1)
                this._expanded.add(activeSubs[0].id);
        }
        this._flattenServers();
        this._rebuildServerList();
        this._updateTrafficLabel();
        if (autoFetch && this._subs.length)
            this._reloadAll();
        else
            this._updateStatusUi();
    }

    // prefs.js only stores metadata (name, url, enabled, order); merge without wiping in-memory servers
    _mergeSubsFromSettings() {
        const meta = this._readMetaSubs();
        const byUrl = new Map(this._subs.map(s => [s.url, s]));
        const byId = new Map(this._subs.map(s => [s.id, s]));
        const next = [];
        const needFetch = [];
        for (const m of meta) {
            const prev = byId.get(m.id) || byUrl.get(m.url);
            const enabled = m.enabled !== false;
            if (prev) {
                const urlChanged = m.url && m.url !== prev.url;
                next.push({
                    ...prev,
                    id: m.id || prev.id,
                    name: m.name || prev.name,
                    url: m.url || prev.url,
                    enabled,
                });
                const cur = next[next.length - 1];
                if (enabled && cur.url && (urlChanged || (!cur.servers?.length && !cur.updatedAt)))
                    needFetch.push(cur);
            } else {
                const sub = {
                    id: m.id || `sub_${Date.now()}`,
                    name: m.name || 'Sub',
                    url: m.url,
                    enabled,
                    servers: [],
                    traffic: null,
                    error: null,
                };
                next.push(sub);
                if (enabled) needFetch.push(sub);
            }
        }
        this._subs = next;
        this._afterSubsChanged();
        // fetch what was added or re-pointed from prefs in the background
        for (const sub of needFetch) {
            if (sub.url)
                this._updateSub(sub, true).then(() => this._afterSubsChanged());
        }
    }

    _handleUpdateRequest() {
        const value = this._settings.get_string('update-request');
        if (!value) return;
        const id = value.split('|')[0];
        if (id === 'all') {
            this._reloadAll();
            return;
        }
        const sub = this._subs.find(x => x.id === id);
        if (sub)
            this._updateSub(sub);
    }

    _saveSubs() {
        // GSettings: metadata only (small). Servers live in CACHE_FILE.
        const meta = this._subs.map(s => ({
            id: s.id,
            name: s.name,
            url: s.url,
            enabled: s.enabled !== false,
        }));
        this._writingSubs = true;
        try {
            this._settings.set_string('subscriptions', JSON.stringify(meta));
        } finally {
            // allow changed handler on next event loop tick
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._writingSubs = false;
                return GLib.SOURCE_REMOVE;
            });
        }
        this._writeCache();
    }

    _updateStatusUi() {
        const t = k => this.t(k);
        const state = this._connecting
            ? 'busy'
            : (this._blocked
                ? 'blocked'
                : (this._connected && this._connectedServer ? 'online' : 'offline'));
        this._hero.style_class = `qurp-hero ${state}`;
        this._exitRow.style_class = `qurp-exit-row${state === 'online' ? '' : ' dim'}`;
        this._badge.style_class = `qurp-badge ${state}`;
        this._metaLabel.visible = state === 'online';

        if (state === 'online') {
            const r = this._rate;
            const live = this._liveMs === null ? null : (this._liveMs > 0 ? `${this._liveMs} ms` : '✕');
            const speed = r ? `↓ ${formatRate(r.proxyDown)}  ↑ ${formatRate(r.proxyUp)}` : t('connected');
            this._heroGlyph.icon_name = 'network-vpn-symbolic';
            this._statusTitle.text = this._connectedServer.display;
            this._statusSub.text = [live, speed].filter(Boolean).join(' · ');
            this._badge.text = t('online');
            this.subtitle = this._connectedServer.display;

            const meta = [];
            if (this._connectedServer.subName) meta.push(this._connectedServer.subName);
            if (this._singbox.ksActive) meta.push(t('kill_switch_on'));
            if (this._activeTun) meta.push('TUN');
            const tr = this._tracker;
            const approx = tr.approximate() ? '~' : '';
            meta.push(`${t('session')} ↓ ${formatBytes(tr.proxy.down)}${approx} ↑ ${formatBytes(tr.proxy.up)}${approx}`);
            if (tr.direct.down + tr.direct.up > 0)
                meta.push(`${t('direct')} ↓ ${formatBytes(tr.direct.down)}${approx}`);
            this._metaLabel.text = meta.join(' · ');
        } else if (state === 'blocked') {
            this._heroGlyph.icon_name = 'network-offline-symbolic';
            this._statusTitle.text = t('blocked_title');
            this._statusSub.text = t('blocked_sub');
            this._badge.text = t('blocked');
            this.subtitle = t('blocked');
        } else if (state === 'busy') {
            this._heroGlyph.icon_name = 'network-vpn-acquiring-symbolic';
            this._statusTitle.text = this._selected?.display ?? t('app_name');
            this._statusSub.text = t('connecting');
            this._badge.text = t('connecting');
            this.subtitle = t('connecting');
        } else {
            this._heroGlyph.icon_name = 'network-vpn-disabled-symbolic';
            this._statusTitle.text = t('app_name');
            this._statusSub.text = this._servers.length
                ? `${this._servers.length} ${t('servers')}`
                : t('no_subs');
            this._badge.text = t('offline');
            this.subtitle = t('off');
        }
        this._updateTrafficLabel();
    }

    // Quota line: the subscription of the connected (or selected) server, as reported by its provider.
    _updateTrafficLabel() {
        const sub = this._focusSub();
        const tr = sub?.traffic;
        if (!sub || !tr) {
            this._trafficLabel.text = `${this.t('traffic')}: ${this.t('traffic_none')}`;
            return;
        }
        const parts = [sub.name];
        if (tr.total > 0)
            parts.push(`${formatBytes(tr.remaining)} ${this.t('traffic_left')}`);
        else
            parts.push(`${formatBytes(tr.used)} ${this.t('traffic_used')}`);
        if (tr.expire) {
            const left = tr.expire * 1000 - Date.now();
            parts.push(left <= 0 ? this.t('expired') : this.t('days_left', {n: Math.ceil(left / 86400000)}));
        }
        this._trafficLabel.text = parts.join(' · ');
    }

    _updateConnectButton() {
        let label, state, reactive = true;
        if (this._connecting) {
            label = this.t('connecting'); state = 'busy'; reactive = false;
        } else if (this._blocked) {
            label = this.t('release_block'); state = 'disconnect';
        } else if (this._connected) {
            label = this.t('disconnect'); state = 'disconnect';
        } else if (this._selected) {
            label = this.t('connect'); state = 'connect';
        } else {
            label = this.t('select_server'); state = 'idle';
        }
        this._connectBtn.label = label;
        this._connectBtn.style_class = `qurp-connect-btn ${state}`;
        this._connectBtn.reactive = reactive;
    }

    /** Non-null string = another long job is running; show it and skip starting a new one. */
    _busyReason({allowPingCancel = false} = {}) {
        if (this._connecting)
            return this.t('best_busy');
        if (this._importing || this._reloading)
            return this.t('loading');
        if (this._pinging && !allowPingCancel)
            return this.t('pinging');
        if (this._autoUpdating)
            return this.t('updating');
        return null;
    }

    _importClipboard() {
        // ignore double-clicks / clicks while another job owns the UI
        const busy = this._busyReason();
        if (busy) {
            this._setTransient(busy);
            return;
        }
        try {
            St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
                try {
                    // state may have changed while the clipboard async returned
                    const stillBusy = this._busyReason();
                    if (stillBusy) {
                        this._setTransient(stillBusy);
                        return;
                    }
                    const raw = (text || '').trim();
                    if (!raw) {
                        this._setTransient(this.t('clipboard_empty'));
                        return;
                    }
                    const url = extractSubUrl(raw);
                    if (!url) {
                        this._setTransient(this.t('no_url'));
                        return;
                    }
                    this._addSub(url, null).catch(e => {
                        Log.error(`import: ${e.message}`);
                        this._setTransient(`${this.t('error')}: ${e.message}`);
                    });
                } catch (e) {
                    Log.error(`import clipboard: ${e.message}`);
                    this._setTransient(`${this.t('error')}: ${e.message}`);
                }
            });
        } catch (e) {
            Log.error(`import clipboard: ${e.message}`);
            this._setTransient(`${this.t('error')}: ${e.message}`);
        }
    }

    async _addSub(url, name) {
        const busy = this._busyReason();
        if (busy) {
            this._setTransient(busy);
            return;
        }
        url = extractSubUrl(url) || url;
        if (!/^https?:\/\//i.test(url || '')) {
            this._setTransient(this.t('no_url'));
            return;
        }
        const existing = this._subs.find(s => s.url === url);
        // max only for brand-new URLs
        if (!existing && this._subs.length >= MAX_SUBS) {
            this._setTransient(this.t('max_subs', {n: MAX_SUBS}));
            return;
        }
        this._importing = true;
        this._importBtn?.add_style_class_name('busy');
        this._setTransient(this.t('loading'));
        const token = ++this._importGen || (this._importGen = 1);
        try {
            const {servers, traffic, meta} = await this._subMgr.fetchSmart(url, this._fetchCtx());
            // dropped / superseded while in flight
            if (this._destroyed || token !== this._importGen)
                return;
            if (!Array.isArray(servers))
                throw new Error('invalid subscription response');
            if (existing) {
                existing.servers = servers;
                existing.traffic = traffic;
                existing.updatedAt = new Date().toISOString();
                existing.error = null;
                existing.enabled = true;
                if (name) existing.name = name;
            } else {
                // re-check limit in case another path raced (should not, but safe)
                if (this._subs.length >= MAX_SUBS) {
                    this._setTransient(this.t('max_subs', {n: MAX_SUBS}));
                    return;
                }
                this._subs.push({
                    id: `sub_${Date.now()}_${Math.floor(Math.random() * 1e4)}`,
                    name: name || meta?.title || `${this.t('sub')} ${this._subs.length + 1}`,
                    url,
                    servers,
                    traffic,
                    enabled: true,
                    error: null,
                    updatedAt: new Date().toISOString(),
                });
            }
            this._saveSubs();
            this._afterSubsChanged();
            this._setTransient(this.t('loaded_n', {n: servers.length}));
        } catch (e) {
            Log.error(`import: ${e.message}`);
            if (!this._destroyed)
                this._setTransient(`${this.t('error')}: ${e.message}`);
        } finally {
            this._importing = false;
            this._importBtn?.remove_style_class_name('busy');
        }
    }

    _flattenServers() {
        this._servers = [];
        const seen = new Set();
        for (const sub of this._subs) {
            for (const s of sub.servers || []) {
                s.subId = sub.id;
                s.subName = sub.name;
                if (sub.enabled === false)
                    continue;
                // the same server in two subscriptions is listed and measured once
                if (seen.has(s.id)) {
                    s.dup = true;
                    continue;
                }
                seen.add(s.id);
                s.dup = false;
                this._servers.push(s);
            }
        }
    }

    // Re-link selection / connection after the server objects were replaced, then redraw.
    _afterSubsChanged() {
        const selId = this._selected?.id ?? null;
        const connId = this._connectedServer?.id ?? null;
        this._flattenServers();
        if (selId)
            this._selected = this._servers.find(s => s.id === selId) ?? null;
        if (this._connected && connId) {
            const still = this._servers.find(s => s.id === connId);
            if (still) {
                this._connectedServer = still;
            } else {
                // A provider that rotates credentials changes the server id. The same endpoint in the
                // same subscription is the same server: follow it instead of dropping the connection.
                const prev = this._connectedServer;
                const key = x => `${x.subId}|${x.protocol}|${x.host}|${x.port}|${x.network || ''}`;
                const same = prev ? this._servers.find(x => key(x) === key(prev)) : null;
                if (same) {
                    Log.info('Connected server was re-issued by its provider; reconnecting with the new details');
                    this._connectedServer = same;
                    this._selected = same;
                    this._connectServer(same, {auto: true})
                        .catch(e => Log.warn(`reconnect to re-issued server: ${e.message}`));
                } else {
                    Log.warn('Connected server removed or its subscription disabled');
                    this._doDisconnect().then(() => this._setTransient(this.t('server_removed')));
                }
            }
        }
        this._rebuildServerList();
        this._updateTrafficLabel();
        this._updateConnectButton();
        this._updateStatusUi();
    }

    async _updateSub(sub, silent = false) {
        if (!sub?.url || sub._updating)
            return false;
        // Manual single-sub update: don't clash with import / ping / connect.
        // (Bulk reload holds _reloading and calls us with silent=true.)
        if (!silent && !this._reloading) {
            const busy = this._busyReason();
            if (busy) {
                this._setTransient(busy);
                return false;
            }
        }
        sub._updating = true;
        if (!silent)
            this._setTransient(`${this.t('updating')} ${sub.name}`);
        let ok = false;
        try {
            const {servers, traffic} = await this._subMgr.fetchSmart(sub.url, this._fetchCtx());
            if (this._destroyed) return false;
            // keep latency results of servers that are still in the list
            const old = new Map((sub.servers || []).map(s => [s.id, s]));
            for (const s of servers) {
                const o = old.get(s.id);
                if (o) {
                    s.latency = o.latency ?? null;
                    s.pingState = o.pingState;
                    s.pingAt = o.pingAt;
                }
            }
            sub.servers = servers;
            sub.traffic = traffic;
            sub.updatedAt = new Date().toISOString();
            sub.error = null;
            ok = true;
        } catch (e) {
            sub.error = String(e.message || e).slice(0, 120);
            Log.error(`update ${sub.name}: ${e.message}`);
        } finally {
            sub._updating = false;
        }
        this._saveSubs();
        if (!silent)
            this._afterSubsChanged();
        return ok;
    }

    async _reloadAll(silent = false) {
        const busy = this._busyReason();
        if (busy) {
            if (!silent) this._setTransient(busy);
            return;
        }
        const active = this._subs.filter(s => s.enabled !== false && s.url);
        if (!active.length) {
            if (!silent) this._setTransient(this.t('no_subs'));
            return;
        }
        this._reloading = true;
        this._updateBtn?.add_style_class_name('busy');
        if (!silent)
            this._setTransient(this.t('updating'));
        let failed = 0;
        try {
            for (const sub of active) {
                if (this._destroyed)
                    break;
                if (!await this._updateSub(sub, true))
                    failed++;
            }
            if (!this._destroyed) {
                this._afterSubsChanged();
                if (!silent && failed)
                    this._setTransient(this.t('some_failed', {n: failed}));
            }
        } finally {
            this._reloading = false;
            this._updateBtn?.remove_style_class_name('busy');
        }
    }

    _staleMs() {
        return (this._settings.get_int('ping-stale-minutes') || 10) * 60 * 1000;
    }

    _pinnedList() {
        return this._servers.filter(s => this._pinned.has(s.id));
    }

    _togglePin(server) {
        if (this._pinned.has(server.id)) this._pinned.delete(server.id);
        else this._pinned.add(server.id);
        this._settings.set_strv('pinned-servers', [...this._pinned]);
        this._rebuildServerList();
    }

    // Accordion: one subscription open at a time. Opening focuses it: the other banners
    // and the traffic/search rows fold away, so its banner rises to just below the
    // Best / Ping / Update / Import buttons and the servers open downward from there.
    _toggleExpanded(subId) {
        if (this._anim)
            return;
        const opening = !this._expanded.has(subId);
        this._expanded = new Set(opening ? [subId] : []);
        this._settings.set_strv('expanded-subs', [...this._expanded]);
        const entry = this._cards?.get(subId);
        const sub = this._subs.find(x => x.id === subId);
        if (this._query || !entry || !sub || !this._serverBox.get_stage()) {
            this._rebuildServerList();
            return;
        }
        this._beginAnim();
        if (opening)
            this._animateOpen(sub, entry);
        else
            this._animateClose(subId, entry);
    }

    _animMs() {
        try { return St.Settings.get().enable_animations ? 220 : 0; } catch (e) { return 220; }
    }

    _beginAnim() {
        this._anim = true;
        if (this._animGuard)
            GLib.source_remove(this._animGuard);
        // safety net: never leave the list locked if an animation is interrupted
        this._animGuard = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._animGuard = 0;
            this._anim = false;
            this._rebuildServerList();
            return GLib.SOURCE_REMOVE;
        });
    }

    _endAnim() {
        this._anim = false;
        if (this._animGuard) {
            GLib.source_remove(this._animGuard);
            this._animGuard = 0;
        }
        this._queueFit();
    }

    _foldActor(actor, ms, done) {
        if (!actor || !actor.visible) {
            done?.();
            return;
        }
        actor.clip_to_allocation = true;
        actor.height = actor.get_height();
        actor.ease({
            height: 0, opacity: 0, duration: ms, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                actor.hide();
                actor.set_height(-1);
                actor.opacity = 255;
                done?.();
            },
        });
    }

    _unfoldActor(actor, ms, done) {
        actor.set_height(-1);
        actor.show();
        const nat = actor.get_preferred_height(-1)[1];
        actor.clip_to_allocation = true;
        actor.height = 0;
        actor.opacity = 0;
        actor.ease({
            height: nat, opacity: 255, duration: ms, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                actor.set_height(-1);
                done?.();
            },
        });
    }

    _animateOpen(sub, entry) {
        const ms = this._animMs();
        const {card, head} = entry;
        head._chevron?.set_icon_name('pan-down-symbolic');
        const body = this._makeSubBody(sub);
        entry.body = body;
        card.add_child(body);
        this._applyDirection(body);
        body.set_height(-1);
        const nat = body.get_preferred_height(-1)[1];
        const target = Math.min(nat, Math.max(this._fitHeight ?? SERVER_LIST_MAX_HEIGHT, 120));
        const others = this._serverBox.get_children().filter(c => c !== card);
        const pieces = [...others, ...this._focusRows];
        let pending = pieces.length + 1;
        const done = () => {
            if (--pending > 0)
                return;
            try { this._scrollView.vscroll.adjustment.value = 0; } catch (e) { /* ignore */ }
            this._endAnim();
        };
        body.height = 0;
        body.opacity = 0;
        body.ease({
            height: target, opacity: 255, duration: ms, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => { body.set_height(-1); done(); },
        });
        for (const a of pieces)
            this._foldActor(a, ms, done);
    }

    _animateClose(subId, entry) {
        const ms = Math.round(this._animMs() * 0.8);
        entry.head._chevron?.set_icon_name('pan-end-symbolic');
        const after = () => {
            this._rebuildServerList();          // overview layout (nothing expanded)
            const card = this._cards.get(subId)?.card;
            const pieces = [...this._serverBox.get_children().filter(c => c !== card), ...this._focusRows];
            let pending = pieces.length;
            if (!pending) {
                this._endAnim();
                return;
            }
            for (const a of pieces) {
                this._unfoldActor(a, this._animMs(), () => {
                    if (--pending <= 0)
                        this._endAnim();
                });
            }
        };
        const body = entry.body;
        if (!body) {
            after();
            return;
        }
        body.clip_to_allocation = true;
        body.height = body.get_height();
        body.ease({
            height: 0, opacity: 0, duration: ms, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: after,
        });
    }

    // Show or hide the rows that only make sense in the overview (traffic, search).
    _setFocusRows(show) {
        for (const a of this._focusRows ?? []) {
            a.remove_all_transitions?.();
            a.set_height(-1);
            a.opacity = 255;
            if (show) a.show(); else a.hide();
        }
    }

    _makeSubBody(sub) {
        const body = new St.BoxLayout({vertical: true, x_expand: true, clip_to_allocation: true});
        const list = (sub.servers || []).filter(s => !s.dup);
        for (const s of list)
            body.add_child(this._makeServerRow(s, false));
        if (!list.length) {
            body.add_child(new St.Label({
                text: sub.error ? `${this.t('update_failed')}: ${sub.error}` : this.t('no_servers'),
                style_class: 'qurp-empty',
            }));
        }
        return body;
    }

    _focusSub() {
        const id = this._connectedServer?.subId ?? this._selected?.subId;
        const active = this._subs.filter(s => s.enabled !== false);
        return active.find(s => s.id === id) ?? active[0] ?? null;
    }

    _rebuildServerList() {
        let scrollPos = 0;
        try { scrollPos = this._scrollView.vscroll.adjustment.value; } catch (e) { /* not ready */ }

        this._serverBox.destroy_all_children();
        this._rowRefs = new Map();
        this._cards = new Map();
        const CENTER = Clutter.ActorAlign.CENTER;
        const active = this._subs.filter(s => s.enabled !== false);
        const focusId = this._query ? null : ([...this._expanded][0] ?? null);
        const focusSub = focusId ? active.find(x => x.id === focusId) ?? null : null;
        if (!this._anim)
            this._setFocusRows(!focusSub);

        const emptyBox = (icon, title, sub) => {
            const box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'qurp-empty-box'});
            box.add_child(new St.Icon({
                icon_name: icon, icon_size: 28, style_class: 'qurp-empty-icon', x_align: CENTER,
            }));
            box.add_child(new St.Label({text: title, style_class: 'qurp-status-title', x_align: CENTER}));
            if (sub) box.add_child(new St.Label({text: sub, style_class: 'qurp-empty', x_align: CENTER}));
            this._serverBox.add_child(box);
        };

        if (!this._subs.length) {
            emptyBox('folder-download-symbolic', this.t('no_servers'), this.t('no_subs'));
        } else if (!active.length) {
            emptyBox('media-playback-pause-symbolic', this.t('all_disabled'), this.t('all_disabled_hint'));
        } else if (this._query) {
            const q = this._query;
            const hits = this._servers.filter(s =>
                `${s.display} ${s.rawName ?? ''} ${s.host} ${s.subName ?? ''}`.toLowerCase().includes(q));
            if (!hits.length) {
                emptyBox('edit-find-symbolic', this.t('no_results'), '');
            } else {
                this._serverBox.add_child(this._sectionLabel(`${this.t('results')} · ${hits.length}`));
                for (const s of hits.slice(0, 40))
                    this._serverBox.add_child(this._makeServerRow(s, true));
                if (hits.length > 40) {
                    this._serverBox.add_child(new St.Label({
                        text: this.t('more_results', {n: hits.length - 40}), style_class: 'qurp-more',
                    }));
                }
            }
        } else {
            const pinned = focusSub ? [] : this._pinnedList();
            if (pinned.length) {
                this._serverBox.add_child(this._sectionLabel(this.t('pinned')));
                for (const s of pinned)
                    this._serverBox.add_child(this._makeServerRow(s, false));
            }
            if (!focusSub)
                this._serverBox.add_child(this._sectionLabel(`${this.t('subscriptions')} · ${active.length}`));
            for (const sub of (focusSub ? [focusSub] : active)) {
                const card = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'qurp-subcard'});
                const head = this._makeSubHeader(sub);
                card.add_child(head);
                let body = null;
                if (this._expanded.has(sub.id)) {
                    body = this._makeSubBody(sub);
                    card.add_child(body);
                }
                this._cards.set(sub.id, {card, head, body});
                this._serverBox.add_child(card);
            }
        }

        this._applyDirection(this._serverBox);
        this._queueFit();
        if (scrollPos > 0) {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                try { this._scrollView.vscroll.adjustment.value = scrollPos; } catch (e) { /* ignore */ }
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _sectionLabel(text) {
        return new St.Label({text, style_class: 'qurp-section'});
    }

    _iconButton(icon, onClick, tip = '') {
        const props = {style_class: 'qurp-icon-btn', can_focus: true};
        // GObject rejects accessible_name: undefined — only set when we have text
        if (tip)
            props.accessible_name = String(tip);
        const b = new St.Button(props);
        b.child = new St.Icon({icon_name: icon, icon_size: 14});
        if (tip)
            attachHoverTip(b, tip);
        else
            attachHoverTip(b, () => b.accessible_name || '');
        b.connect('clicked', () => onClick());
        return b;
    }

    _makeSubHeader(sub) {
        const CENTER = Clutter.ActorAlign.CENTER;
        const open = this._expanded.has(sub.id);
        const health = subHealth(sub);

        const head = new St.Button({style_class: 'qurp-subhead', x_expand: true, can_focus: true});
        const box = new St.BoxLayout({vertical: false, x_expand: true, style_class: 'qurp-row-inner'});
        head._chevron = new St.Icon({
            icon_name: open ? 'pan-down-symbolic' : 'pan-end-symbolic',
            icon_size: 14, y_align: CENTER, style_class: 'qurp-chevron',
        });
        box.add_child(head._chevron);
        box.add_child(new St.Widget({style_class: `qurp-dot ${health.dot}`, y_align: CENTER}));

        const col = new St.BoxLayout({vertical: true, x_expand: true, y_align: CENTER});
        col.add_child(new St.Label({text: sub.name, style_class: 'qurp-sub-name'}));
        col.add_child(new St.Label({text: subSummary(sub, (k, v) => this.t(k, v)), style_class: 'qurp-sub-line'}));
        const frac = usageFraction(sub);
        if (frac !== null) {
            const track = new St.BoxLayout({style_class: 'qurp-bar'});
            const level = frac >= 0.95 ? ' crit' : (frac >= 0.8 ? ' warn' : '');
            track.add_child(new St.Widget({
                style_class: `qurp-bar-fill${level}`,
                style: `width: ${Math.max(2, Math.round(160 * frac))}px;`,
            }));
            col.add_child(track);
        }
        box.add_child(col);

        box.add_child(new St.Label({
            text: `${(sub.servers || []).filter(s => !s.dup).length}`,
            style_class: 'qurp-sub-count', y_align: CENTER,
        }));
        box.add_child(this._iconButton('network-transmit-receive-symbolic', () => {
            this._pingServers((sub.servers || []).filter(s => !s.dup && this._servers.includes(s)));
        }, this.t('ping')));
        box.add_child(this._iconButton('view-refresh-symbolic', () => this._updateSub(sub), this.t('update')));
        head.set_child(box);
        head.connect('clicked', () => this._toggleExpanded(sub.id));
        return head;
    }

    _makeServerRow(server, showSub) {
        const CENTER = Clutter.ActorAlign.CENTER;
        const isConnected = !!(this._connected && this._connectedServer &&
            server.id === this._connectedServer.id);
        const isSelected = this._selected?.id === server.id;
        const state = isConnected ? 'connected' : (isSelected ? 'selected' : '');

        const row = new St.Button({
            style_class: `qurp-server-row ${state}`.trim(),
            x_expand: true, can_focus: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
        });
        const box = new St.BoxLayout({vertical: false, x_expand: true, style_class: 'qurp-row-inner'});
        box.add_child(new St.Widget({style_class: `qurp-radio ${state}`.trim(), y_align: CENTER}));
        const {flag, name} = splitDisplay(server.display || displayName(server));
        box.add_child(new St.Label({text: flag, style_class: 'qurp-flag', y_align: CENTER}));

        const nameCol = new St.BoxLayout({vertical: true, x_expand: true, y_align: CENTER});
        nameCol.add_child(new St.Label({
            text: name, style_class: state ? 'qurp-server-name active' : 'qurp-server-name',
        }));
        if (showSub && server.subName)
            nameCol.add_child(new St.Label({text: server.subName, style_class: 'qurp-sub-line'}));
        box.add_child(nameCol);

        if (server.protocol) {
            box.add_child(new St.Label({
                text: String(server.protocol).toUpperCase(), style_class: 'qurp-proto', y_align: CENTER,
            }));
        }
        const view = latencyView(server, this._staleMs());
        const lat = new St.Label({
            text: view.text, style_class: `qurp-lat-badge ${view.cls}`, y_align: CENTER,
        });
        box.add_child(lat);
        const refs = this._rowRefs.get(server.id) ?? [];
        refs.push(lat);
        this._rowRefs.set(server.id, refs);

        const pinned = this._pinned.has(server.id);
        const pinBtn = this._iconButton(pinned ? 'starred-symbolic' : 'non-starred-symbolic',
            () => this._togglePin(server), pinned ? 'Unpin' : 'Pin');
        box.add_child(pinBtn);
        row.set_child(box);

        row.connect('clicked', (_b, btn) => {
            if (btn === 3) {
                this._copyServerLink(server);
                return;
            }
            if ((this._connected && this._connectedServer &&
                server.id !== this._connectedServer.id) || this._blocked) {
                this._selected = server;
                this._connectServer(server);
                return;
            }
            if (this._connected && this._connectedServer?.id === server.id)
                return;
            this._selected = server;
            this._rebuildServerList();
            this._updateConnectButton();
            this._updateTrafficLabel();
            this._setTransient(`${this.t('selected')}: ${server.display}`);
        });
        return row;
    }

    async _onConnectButton() {
        if (this._connected || this._blocked) {
            await this._doDisconnect();
            return;
        }
        if (!this._selected) {
            this._setTransient(this.t('select_server'));
            return;
        }
        await this._connectServer(this._selected);
    }

    _errText(e) {
        const base = e.key ? this.t(e.key) : e.message;
        return e.key && e.detail ? `${base}: ${e.detail}` : base;
    }

    async _releaseKs() {
        if (!this._singbox.ksActive) return true;
        try {
            await this._singbox.releaseKillSwitch();
            return true;
        } catch (e) {
            Log.warn(`kill switch release: ${e.message}`);
            this._blocked = true;
            return false;
        }
    }

    async _connectServer(server, {auto = false} = {}) {
        if (this._connecting) return;
        if (!auto)
            this._rcGen++;               // a manual choice cancels any reconnect loop in progress
        this._connecting = true;
        this._selected = server;
        this._clearExitIp();
        this._stopStats();
        this._updateConnectButton();
        this._updateStatusUi();
        this._setTransient(`${this.t('loading')} ${server.display}`);
        const tun = this._settings.get_string('connection-mode') === 'tun';
        const wantKs = this._settings.get_boolean('kill-switch');
        try {
            if (server.unsupported)
                throw keyedError('unsupported_transport', server.unsupported);
            let pinIp = null;
            if (wantKs) {
                // Fail closed: when the firewall cannot be set up we do not connect at all
                // (it used to carry on unprotected after a one-line warning).
                let ips = [];
                try {
                    ips = await resolveHost(server.host);
                } catch (e) {
                    throw keyedError('ks_failed', `${server.host}: ${e.message}`.slice(0, 120));
                }
                if (!ips.length)
                    throw keyedError('ks_failed', server.host);
                try {
                    await this._singbox.applyKillSwitch(ips, tun, this._singbox.directCidrs());
                } catch (e) {
                    throw e.key ? e : keyedError('ks_failed', e.message);
                }
                // the core connects to exactly the address the firewall allows (no second DNS lookup)
                pinIp = ips.find(i => !i.includes(':')) ?? ips[0];
            } else if (this._singbox.ksActive) {
                await this._releaseKs();
            }
            const dnsLeak = this._settings.get_boolean('dns-leak-protection');
            await this._singbox.connect(server, {dnsLeak, tun, pinIp, ks: wantKs});
            if (wantKs && this._singbox.hasUnhonouredDirectRules()) {
                Log.warn('kill switch: direct rules for domains and apps are not applied');
                this._setTransient(this.t('ks_direct_ignored'));
            }
            this._connected = true;
            this._blocked = false;
            this._liveFails = 0;
            this._activeTun = tun;
            this._connectedServer = server;
            this.checked = true;
            this._settings.set_string('last-server-id', server.id);
            this._startStats();
            if (this._settings.get_boolean('exit-ip-check')) {
                this._exitIpLabel.text = this.t('checking');
                this._scheduleExitIpCheck();
            }
        } catch (e) {
            logFailure('error', 'connect', e);
            this._connected = false;
            this._connectedServer = null;
            this.checked = false;
            await this._releaseKs();
            this._setTransient(`${this.t('error')}: ${this._errText(e)}`);
        } finally {
            this._connecting = false;
            this._updateConnectButton();
            this._updateStatusUi();
            this._rebuildServerList();
        }
    }

    async _doDisconnect() {
        this._rcGen++;                   // cancels a reconnect loop
        this._stopStats();
        this._singbox.disconnect();
        this._connected = false;
        this._connectedServer = null;
        this._blocked = false;
        this.checked = false;
        this._clearExitIp();
        const released = await this._releaseKs();
        this._updateConnectButton();
        this._updateStatusUi();
        this._rebuildServerList();
        this._setTransient(this.t(released ? 'disconnected' : 'ks_release_failed'));
    }

    // The core died on its own. With the kill switch on, traffic stays blocked until the user reconnects or releases it.
    _onCoreExit(status) {
        Log.error(`sing-box exited unexpectedly (code ${status})`);
        const lost = this._connectedServer;
        this._stopStats();
        this._connected = false;
        this._connectedServer = null;
        this.checked = false;
        this._clearExitIp();
        this._blocked = this._singbox.ksActive;
        this._updateConnectButton();
        this._updateStatusUi();
        this._rebuildServerList();
        this._setTransient(this.t(this._blocked ? 'blocked_sub' : 'core_exited'));
        if (lost && this._settings.get_boolean('auto-reconnect'))
            this._reconnect(lost);
    }

    _startStats() {
        this._stopStats();
        this._tracker = new TrafficTracker();
        this._liveMs = null;
        this._tickCount = 0;
        this._skip = 0;
        this._liveFails = 0;
        this._lastLive = GLib.get_monotonic_time() - 27e6;   // first latency probe about 3 s after connecting
        this._statsSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._tickStats();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopStats() {
        if (this._statsSource) {
            GLib.source_remove(this._statsSource);
            this._statsSource = 0;
        }
        if (this._tracker?.hasData) {
            Log.info(`Session: ${this._tracker.summary()}`);
            this._tracker.hasData = false;
        }
        this._flushUsage();
        this._rate = null;
        this._liveMs = null;
    }

    _flushUsage() {
        if (this._usageDirty) {
            saveUsage(this._usage);
            this._usageDirty = false;
        }
    }

    async _tickStats() {
        if (this._statsBusy || !this._connected) return;
        // nobody sees the numbers while the menu is closed: ask the core only every 5th second
        // (usage is still counted; connections that came and went are covered by the estimate)
        if (!this.menu.isOpen && ++this._skip % 5)
            return;
        this._statsBusy = true;
        try {
            const snap = await this._singbox.fetchConnections();
            if (snap && this._connected) {
                const res = this._tracker.update(snap, GLib.get_monotonic_time());
                this._rate = res.rate;
                const sid = this._connectedServer?.subId;
                if (sid && (res.dProxy.up || res.dProxy.down)) {
                    const u = this._usage[sid] ??= {up: 0, down: 0, since: new Date().toISOString()};
                    u.up += res.dProxy.up;
                    u.down += res.dProxy.down;
                    this._usageDirty = true;
                }
                this._tickCount++;
                const nowUs = GLib.get_monotonic_time();
                if (nowUs - this._lastLive > 30e6) {
                    this._lastLive = nowUs;
                    this._pollLive();
                    this._flushUsage();
                }
                if (!this._transientSource && this.menu.isOpen)
                    this._updateStatusUi();
            }
        } catch (e) { /* core still starting */ } finally {
            this._statsBusy = false;
        }
    }

    async _pollLive() {
        try {
            const ms = await this._singbox.liveDelay(5000);
            if (this._connected && ms !== null) {
                this._liveMs = ms;
                if (ms > 0) {
                    this._liveFails = 0;
                } else if (++this._liveFails >= 3 && !this._reconnecting &&
                           this._settings.get_boolean('auto-reconnect')) {
                    // three probes in a row (about 90 s) through a core that is still running: the tunnel is dead
                    this._liveFails = 0;
                    Log.warn('watchdog: the tunnel stopped answering; reconnecting');
                    this._reconnect(this._connectedServer);
                }
            }
        } catch (e) { /* ignore */ }
    }

    _fetchCtx() {
        return {
            connected: this._connected,
            ks: this._singbox.ksActive,
            port: this._settings.get_int('proxy-port') || 2080,
        };
    }

    _startAutoUpdate() {
        this._autoUpdateSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 600, () => {
            this._maybeAutoUpdate();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _maybeAutoUpdate() {
        const hours = this._settings.get_int('sub-update-hours');
        if (!hours || !this._subs.length || this._autoUpdating || this._importing || this._reloading || this._connecting || this._pinging)
            return;
        if (Date.now() - this._lastAutoTry < 30 * 60 * 1000)
            return;
        const live = this._subs.filter(x => x.enabled !== false && x.url);
        if (!live.length)
            return;
        const oldest = Math.min(...live.map(x => Date.parse(x.updatedAt) || 0));
        if (Date.now() - oldest < hours * 3600 * 1000)
            return;
        this._lastAutoTry = Date.now();
        this._autoUpdating = true;
        try {
            await this._reloadAll(true);
        } finally {
            this._autoUpdating = false;
        }
    }

    _copyServerLink(server) {
        if (!server.link) {
            this._setTransient(this.t('no_link'));
            return;
        }
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, server.link);
        this._setTransient(this.t('link_copied'));
    }

    _onQuickToggle() {
        if (this._connecting) {
            // a connect is already in progress: keep the tile as it was instead of racing it
            this.checked = this._connected;
            return;
        }
        if (this.checked) {
            if (this._selected)
                this._connectServer(this._selected);
            else {
                this.checked = false;
                this._setTransient(this.t('select_server'));
            }
        } else {
            this._doDisconnect();
        }
    }

    _scheduleExitIpCheck() {
        if (this._exitIpSource)
            GLib.source_remove(this._exitIpSource);
        // give the tunnel a moment to carry its first packets
        this._exitIpSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
            this._exitIpSource = 0;
            this._checkExitIp();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Up to 5 rounds with growing waits; shows "Checking…" until one succeeds, so a
    // slow first handshake no longer ends in a false "Couldn't verify".
    async _checkExitIp() {
        if (!this._connected) {
            this._clearExitIp();
            return;
        }
        this._cancelExitIp();
        const gen = ++this._exitIpGen;
        const cancel = this._exitIpCancel = new Gio.Cancellable();
        const port = this._singbox.port;
        const server = this._connectedServer?.id;
        this._exitIpLabel.text = this.t('checking');
        const waits = [0, 1200, 2500, 4000, 6000];
        let lastErr = null;
        for (const wait of waits) {
            if (wait)
                await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, () => { r(); return GLib.SOURCE_REMOVE; }));
            // stale: user disconnected, switched server, or started a newer check
            if (gen !== this._exitIpGen || !this._connected || this._connectedServer?.id !== server)
                return;
            try {
                const ip = await fetchExitIp(port, cancel);
                if (gen !== this._exitIpGen)
                    return;
                this._exitIpLabel.text = ip;
                Log.info(`Exit IP ${ip}`);
                return;
            } catch (e) {
                lastErr = e;
                if (cancel.is_cancelled())
                    return;
            }
        }
        if (gen === this._exitIpGen) {
            Log.warn(`exit ip: ${lastErr?.message}`);
            this._exitIpLabel.text = this.t('verify_failed');
        }
    }

    _cancelExitIp() {
        try { this._exitIpCancel?.cancel(); } catch (e) { /* ignore */ }
        this._exitIpCancel = null;
    }

    _clearExitIp() {
        if (this._exitIpSource) {
            GLib.source_remove(this._exitIpSource);
            this._exitIpSource = 0;
        }
        this._exitIpGen = (this._exitIpGen ?? 0) + 1;
        this._cancelExitIp();
        this._exitIpLabel.text = '—';
    }

    _applyPingResult(server, r) {
        server.latency = r.ms;
        server.pingState = r.state;
        server.pingAt = Date.now();
        const refs = this._rowRefs.get(server.id);
        if (refs) {
            const v = latencyView(server, this._staleMs());
            for (const l of refs) {
                l.text = v.text;
                l.style_class = `qurp-lat-badge ${v.cls}`;
            }
        }
    }

    _cancelPing() {
        if (this._pingSignal)
            this._pingSignal.cancelled = true;
        this._singbox.cancelMeasure();
    }

    async _pingAll() {
        return await this._pingServers(this._servers);
    }

    // Returns true when the run finished (not cancelled).
    async _pingServers(list, {toggle = true} = {}) {
        if (this._pinging) {
            if (toggle) this._cancelPing();
            return false;
        }
        // don't start a ping while import / update / connect is in flight
        const busy = this._busyReason({allowPingCancel: true});
        if (busy) {
            this._setTransient(busy);
            return false;
        }
        const all = list.filter(s => !s.dup);
        if (!all.length) {
            this._setTransient(this.t('no_servers'));
            return false;
        }
        if (this._singbox.ksActive) {
            // the firewall lets only the active server's address out: every other server would just time out
            this._setTransient(this.t('ks_blocks_ping'));
            return false;
        }
        const servers = all.filter(s => !s.unsupported);
        const unsupported = all.filter(s => s.unsupported);
        this._pinging = true;
        this._pingSignal = {cancelled: false};
        const signal = this._pingSignal;
        this._pingBtn.add_style_class_name('busy');
        this._pingBtn._label.text = this.t('cancel');

        const timeout = this._settings.get_int('ping-timeout') || 3000;
        const probes = Math.max(1, Math.min(5, this._settings.get_int('ping-probes') || 2));
        let done = 0;
        const total = all.length;
        const seen = new Set();
        const onResult = (s, r) => {
            if (signal.cancelled) return;
            this._applyPingResult(s, r);
            if (!seen.has(s.id)) {
                seen.add(s.id);
                done++;
            }
            this._setTransient(`${this.t('pinging')} ${done}/${total}`);
        };

        for (const s of unsupported)
            onResult(s, {ms: -1, state: 'na'});

        let measured = false;
        if (this._settings.get_string('ping-mode') === 'real') {
            try {
                await this._singbox.measureDelays(servers, {
                    probes, timeoutMs: Math.max(timeout, 1500), onResult, signal,
                });
                measured = true;
            } catch (e) {
                logFailure('warn', 'real ping', e);
                this._setTransient(this.t('real_ping_failed'));
            }
        }
        if (!measured && !signal.cancelled) {
            // TCP connect only; UDP based protocols cannot be measured this way
            let i = 0;
            const run = async () => {
                while (i < servers.length && !signal.cancelled) {
                    const s = servers[i++];
                    if (s.protocol === 'hysteria2') {
                        onResult(s, {ms: -1, state: 'na'});
                        continue;
                    }
                    const t0 = GLib.get_monotonic_time();
                    const ms = await measureLatency(s.host, s.port, timeout);
                    const elapsed = (GLib.get_monotonic_time() - t0) / 1000;
                    onResult(s, ms >= 0
                        ? {ms, state: 'ok'}
                        : {ms: -1, state: elapsed >= timeout * 0.9 ? 'timeout' : 'error'});
                }
            };
            // TCP connect is cheap — run many in parallel
            const tcpWorkers = Math.min(20, Math.max(8, servers.length));
            await Promise.all(Array.from({length: tcpWorkers}, () => run()));
        }

        const cancelled = signal.cancelled;
        this._pinging = false;
        this._pingSignal = null;
        this._pingBtn.remove_style_class_name('busy');
        this._pingBtn._label.text = this.t('ping');

        if (!cancelled) {
            const rank = s => (s.pingState === 'ok' || s.pingState === 'unstable') ? s.latency : 99999;
            for (const sub of this._subs) {
                if (sub.servers)
                    sub.servers.sort((a, b) => rank(a) - rank(b));
            }
            this._flattenServers();
        }
        this._writeCache();
        this._rebuildServerList();
        const ok = servers.filter(s => s.pingState === 'ok' || s.pingState === 'unstable').length;
        this._setTransient(cancelled
            ? this.t('ping_cancelled')
            : `${this.t('ping')} · ${ok}/${servers.length}`);
        return !cancelled;
    }

    _bestServer() {
        const stale = this._staleMs();
        let best = null;
        let bestScore = Infinity;
        for (const s of this._servers) {
            if (!isFresh(s, stale)) continue;
            const score = s.latency * (s.pingState === 'unstable' ? 1.5 : 1);
            if (score < bestScore) {
                best = s;
                bestScore = score;
            }
        }
        return best;
    }

    async _connectBest() {
        if (this._connecting) {
            Log.info('best: ignored, a connection is in progress');
            this._setTransient(this.t('best_busy'));
            return;
        }
        if (this._pinging) {
            this._setTransient(this.t('pinging'));
            return;
        }
        if (this._importing || this._reloading) {
            this._setTransient(this.t('loading'));
            return;
        }
        this._bestBtn.add_style_class_name('busy');
        this._bestBtn._label.text = this.t('best_testing');
        try {
            let pick = this._bestServer();
            Log.info(`best: ${pick ? 'using fresh ping data' : 'no fresh ping data, measuring'}`);
            if (!pick) {
                this._setTransient(this.t('best_probing'));
                const finished = await this._pingServers(this._servers, {toggle: false});
                if (!finished) {
                    Log.info('best: measuring did not finish');
                    return;
                }
                pick = this._bestServer();
            }
            if (!pick) {
                Log.warn('best: no server answered');
                Main.notify('Qurp', this.t('best_none'));
                return;
            }
            const info = {name: pick.display ?? pick.name ?? '', ms: Math.round(pick.latency)};
            if (this._connected && this._connectedServer?.id === pick.id) {
                this._setTransient(this.t('best_already', info));
                return;
            }
            Log.info(`best: connecting to ${info.name} (${info.ms} ms)`);
            await this._connectServer(pick);
            if (this._connected)
                this._setTransient(this.t('best_picked', info));
        } finally {
            this._bestBtn.remove_style_class_name('busy');
            this._bestBtn._label.text = this.t('best');
        }
    }

    _setTransient(text) {
        // brief override of the subtitle row, restored to the real state afterwards
        this._statusSub.text = text;
        if (this._transientSource)
            GLib.source_remove(this._transientSource);
        this._transientSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            this._transientSource = 0;
            this._updateStatusUi();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._destroyed = true;
        this._rcGen++;
        this._subMgr?.abort();
        if (this._netMon && this._netId)
            this._netMon.disconnect(this._netId);
        this._netId = 0;
        if (this._netTimer) {
            GLib.source_remove(this._netTimer);
            this._netTimer = 0;
        }
        if (this._settingsSig) {
            this._settings.disconnect(this._settingsSig);
            this._settingsSig = 0;
        }
        this._vcCancel?.cancel();
        for (const k of ['_vcKick', '_vcSource']) {
            if (this[k]) { GLib.source_remove(this[k]); this[k] = 0; }
        }
        if (this._transientSource) {
            GLib.source_remove(this._transientSource);
            this._transientSource = 0;
        }
        this._cancelPing();
        if (this._queryTimer) {
            GLib.source_remove(this._queryTimer);
            this._queryTimer = 0;
        }
        this._stopStats();
        if (this._autoUpdateSource) {
            GLib.source_remove(this._autoUpdateSource);
            this._autoUpdateSource = 0;
        }
        this._clearExitIp();
        this._clearFit();
        if (this._animGuard) {
            GLib.source_remove(this._animGuard);
            this._animGuard = 0;
        }
        this._singbox.disconnect();
        if (this._singbox.ksActive)
            this._singbox.releaseKillSwitch().catch(() => {});
        super.destroy();
    }
});

const ProxyIndicator = GObject.registerClass(
class ProxyIndicator extends QuickSettings.SystemIndicator {
    _init(extension) {
        super._init();
        this._toggle = new ProxyToggle(extension);
        this.quickSettingsItems.push(this._toggle);
    }
    destroy() {
        this._toggle?.destroy();
        this._toggle = null;
        super.destroy();
    }
});

export default class QurpExtension extends Extension {
    enable() {
        this._i18n = new I18n(this);
        try {
            this._settings = this.getSettings();
            this._i18n.load(this._settings.get_string('language') || 'en');
        } catch (e) {
            Log.warn(`settings: ${e.message}`);
            this._i18n.load('en');
        }
        Log.info('Qurp enabled');
        this._indicator = new ProxyIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        try {
            this._indicator._toggle?._singbox?.logEnvironment();
        } catch (e) { Log.warn(`environment check: ${e.message}`); }
        this._startPlacement();

        // auto-connect (the timer is tracked so disable() can cancel it)
        try {
            if (this._settings?.get_boolean('auto-connect')) {
                const lastId = this._settings.get_string('last-server-id');
                const best = this._settings.get_boolean('auto-connect-best');
                if (lastId || best) {
                    this._autoTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                        this._autoTimer = 0;
                        const toggle = this._indicator?._toggle;
                        if (toggle) {
                            if (best) {
                                toggle._connectBest().catch(e => Log.warn(`auto-connect: ${e.message}`));
                            } else {
                                const server = toggle._servers.find(s => s.id === lastId);
                                if (server)
                                    toggle._connectServer(server).catch(e => Log.warn(`auto-connect: ${e.message}`));
                            }
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                }
            }
        } catch (e) { /* ignore */ }
    }

    // ---- Quick Settings placement -------------------------------------------
    // addExternalIndicator() appends to the end of the grid. Move the toggle to
    // the user's chosen slot: below-wifi (default), after-wifi, start or end.
    _startPlacement() {
        this._placeTimers = new Set();
        this._placing = false;
        const grid = Main.panel.statusArea.quickSettings?.menu?._grid;
        if (!grid)
            return;
        this._grid = grid;
        // Other indicators (Wi-Fi appears late on some systems) can be added after us.
        this._gridSignal = grid.connect('child-added', () => this._schedulePlace(80));
        this._posSignal = this._settings?.connect('changed::toggle-position',
            () => this._schedulePlace(0));
        this._slotSignal = this._settings?.connect('changed::toggle-slot',
            () => this._schedulePlace(0));
        // Tiles can show or hide (Wi-Fi, Bluetooth); re-check whenever the panel opens.
        const qsMenu = Main.panel.statusArea.quickSettings.menu;
        this._qsMenu = qsMenu;
        this._openSignal = qsMenu.connect('open-state-changed',
            (_m, open) => { if (open) this._placeToggle(); });
        for (const ms of [0, 400, 1500, 4000])
            this._schedulePlace(ms);
    }

    _schedulePlace(ms) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._placeTimers?.delete(id);
            this._placeToggle();
            return GLib.SOURCE_REMOVE;
        });
        this._placeTimers?.add(id);
    }

    _isWifiItem(actor) {
        if (typeof actor.iconName === 'string' && /wireless|wifi/i.test(actor.iconName))
            return true;
        return /wireless|wifi/i.test(actor.constructor?.name ?? '');
    }

    // Only visible tiles count as slots. Sliders (volume, brightness) and hidden
    // tiles don't take a grid cell, so they are ignored.
    // QuickMenuToggle (Wi-Fi, ours) does not extend QuickToggle in GNOME 46-48, so
    // test for "a quick settings item that is not a slider". The top system row and
    // Background apps span two columns, so only one-column items count as slots.
    _isTile(actor) {
        if (!(actor instanceof QuickSettings.QuickSettingsItem) ||
            actor instanceof QuickSettings.QuickSlider || !actor.visible)
            return false;
        try {
            const span = this._grid.layout_manager.get_child_meta(this._grid, actor).columnSpan;
            return span === 1;
        } catch (e) {
            return true;
        }
    }

    // Publish the real tile order so the settings window can draw the real layout.
    _publishLayout() {
        try {
            const toggle = this._indicator?._toggle;
            const tiles = this._grid.get_children().filter(a => a === toggle || this._isTile(a));
            const list = tiles.map(a => ({
                t: String(a.title || a.constructor?.name || '?').slice(0, 24),
                q: a === toggle ? 1 : 0,
            }));
            const json = JSON.stringify(list);
            if (this._settings.get_string('tile-layout') !== json)
                this._settings.set_string('tile-layout', json);
        } catch (e) {
            Log.warn(`publish layout: ${e.message}`);
        }
    }

    _placeToggle() {
        const toggle = this._indicator?._toggle;
        const grid = this._grid;
        if (!toggle || !grid || this._placing)
            return;
        this._placing = true;
        try {
            const pos = this._settings?.get_string('toggle-position') || 'below-wifi';
            const all = grid.get_children();
            const tiles = all.filter(a => a !== toggle && this._isTile(a));
            const wifi = tiles.findIndex(a => this._isWifiItem(a));

            let ins;
            if (pos === 'end')
                ins = tiles.length;
            else if (pos === 'start')
                ins = 0;
            else if (pos === 'custom')
                ins = this._settings.get_int('toggle-slot');
            else if (wifi < 0)
                ins = 0;                       // no Wi-Fi tile: still keep it near the top
            else if (pos === 'after-wifi')
                ins = wifi + 1;                // next to Wi-Fi
            else
                ins = wifi + 2;                // below Wi-Fi (the grid has two columns)
            ins = Math.max(0, Math.min(ins, tiles.length));

            const current = all.filter(a => a === toggle || this._isTile(a)).indexOf(toggle);
            if (current === ins) {
                this._publishLayout();
                return;
            }
            if (ins >= tiles.length)
                grid.set_child_above_sibling(toggle, tiles[tiles.length - 1] ?? null);
            else
                grid.set_child_below_sibling(toggle, tiles[ins]);
            this._publishLayout();
        } catch (e) {
            Log.warn(`placement: ${e.message}`);
        } finally {
            this._placing = false;
        }
    }

    _stopPlacement() {
        for (const id of this._placeTimers ?? [])
            GLib.source_remove(id);
        this._placeTimers = null;
        if (this._grid && this._gridSignal)
            this._grid.disconnect(this._gridSignal);
        if (this._settings && this._posSignal)
            this._settings.disconnect(this._posSignal);
        if (this._settings && this._slotSignal)
            this._settings.disconnect(this._slotSignal);
        if (this._qsMenu && this._openSignal)
            this._qsMenu.disconnect(this._openSignal);
        this._grid = null;
        this._qsMenu = null;
        this._gridSignal = 0;
        this._posSignal = 0;
        this._slotSignal = 0;
        this._openSignal = 0;
    }

    disable() {
        Log.info('Qurp disabled');
        if (this._autoTimer) {
            GLib.source_remove(this._autoTimer);
            this._autoTimer = 0;
        }
        this._stopPlacement();
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
        this._i18n = null;
        Log.flush();
    }
}
