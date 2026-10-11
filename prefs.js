import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const LOG_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'qurp', 'client.log']);
const MAX_SUBS = 10;
const PLACE_CELLS = 10;
const CONFIG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'qurp']);
const CACHE_FILE = GLib.build_filenamev([CONFIG_DIR, 'servers-cache.json']);
const USAGE_FILE = GLib.build_filenamev([CONFIG_DIR, 'usage.json']);

function readJson(path) {
    try {
        const [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
        if (ok) {
            const obj = JSON.parse(new TextDecoder().decode(contents));
            if (obj && typeof obj === 'object') return obj;
        }
    } catch (e) { /* missing or unreadable */ }
    return {};
}

function formatBytes(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = Math.max(0, Number(n));
    let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

// same rules as the panel, so both show the same status
function subHealth(sub) {
    if (sub.enabled === false) return 'disabled';
    if (sub.error) return 'failed';
    const tr = sub.traffic;
    if (tr?.expire && tr.expire * 1000 < Date.now()) return 'expired';
    if (tr?.total > 0 && tr.used >= tr.total) return 'depleted';
    if (!sub.updatedAt) return 'new';
    return 'ok';
}

const HEALTH_ICON = {
    ok: ['emblem-ok-symbolic', 'success'],
    failed: ['dialog-warning-symbolic', 'warning'],
    expired: ['dialog-error-symbolic', 'error'],
    depleted: ['dialog-error-symbolic', 'error'],
    disabled: ['media-playback-pause-symbolic', 'dim-label'],
    new: ['view-refresh-symbolic', 'dim-label'],
};


function hostOf(url) {
    try {
        return GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host() || url;
    } catch (e) {
        return String(url).slice(0, 32);
    }
}

function loadLocale(ext, lang) {
    try {
        const file = ext.dir.get_child('locales').get_child(`${lang}.json`);
        const [ok, contents] = file.load_contents(null);
        if (ok) return JSON.parse(new TextDecoder().decode(contents));
    } catch (e) { /* ignore */ }
    return {};
}

export default class QurpPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._window = window;
        this._settings = this.getSettings();
        this._dict = {};
        this._reloadI18n();

        window._settings = this._settings;
        this._settings.connect('changed::language', () => {
            this._reloadI18n();
            // rebuild is heavy; update titles at least
            this._updatePageTitles();
        });

        this._pageGeneral = new Adw.PreferencesPage({
            title: this.t('prefs_general'),
            icon_name: 'preferences-system-symbolic',
        });
        this._pageSubs = new Adw.PreferencesPage({
            title: this.t('prefs_subscriptions'),
            icon_name: 'network-server-symbolic',
        });
        this._pageRouting = new Adw.PreferencesPage({
            title: this.t('prefs_routing'),
            icon_name: 'network-workgroup-symbolic',
        });
        this._pageLogs = new Adw.PreferencesPage({
            title: this.t('prefs_logs'),
            icon_name: 'text-x-generic-symbolic',
        });
        this._pageAdv = new Adw.PreferencesPage({
            title: this.t('prefs_advanced'),
            icon_name: 'applications-utilities-symbolic',
        });

        this._buildGeneral();
        this._buildSubs();
        this._buildRouting();
        this._buildLogs();
        this._buildAdvanced();

        window.add(this._pageGeneral);
        window.add(this._pageSubs);
        window.add(this._pageRouting);
        window.add(this._pageLogs);
        window.add(this._pageAdv);
        this._setupWindow(window);
    }

    // Window behaviour: resizable, can go fullscreen (F11 or the button on the first
    // page), and content grows with the window instead of staying a 600px column.
    _setupWindow(window) {
        try { window.set_default_size(920, 740); } catch (e) { /* ignore */ }
        try { window.set_resizable(true); } catch (e) { /* ignore */ }
        try { window.set_modal(false); } catch (e) { /* ignore */ }

        try {
            const sc = new Gtk.ShortcutController();
            sc.add_shortcut(new Gtk.Shortcut({
                trigger: Gtk.ShortcutTrigger.parse_string('F11'),
                action: Gtk.CallbackAction.new(() => {
                    this._toggleFullscreen();
                    return true;
                }),
            }));
            window.add_controller(sc);
        } catch (e) { /* ignore */ }

        // AdwPreferencesPage wraps its content in an AdwClamp limited to ~600px.
        // Raise the limit so rows and the position picker use the extra width.
        const widen = w => {
            for (let c = w.get_first_child(); c; c = c.get_next_sibling()) {
                if (c instanceof Adw.Clamp) {
                    c.maximum_size = 1400;
                    c.tightening_threshold = 1000;
                    return true;
                }
                if (widen(c))
                    return true;
            }
            return false;
        };
        const apply = () => {
            for (const page of [this._pageGeneral, this._pageSubs, this._pageRouting,
                this._pageLogs, this._pageAdv]) {
                try { widen(page); } catch (e) { /* ignore */ }
            }
        };
        apply();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { apply(); return GLib.SOURCE_REMOVE; });
        window.connect('map', apply);
    }

    _toggleFullscreen() {
        const w = this._window;
        if (!w)
            return;
        if (w.fullscreened)
            w.unfullscreen();
        else
            w.fullscreen();
    }

    t(key) {
        return this._dict[key] ?? key;
    }

    tf(key, vars = {}) {
        let text = this.t(key);
        for (const [k, v] of Object.entries(vars))
            text = text.split(`{${k}}`).join(String(v));
        return text;
    }

    ago(iso) {
        const ts = Date.parse(iso);
        if (!ts) return this.t('never');
        const mins = Math.floor((Date.now() - ts) / 60000);
        if (mins < 1) return this.t('ago_now');
        if (mins < 60) return this.tf('ago_min', {n: mins});
        const hours = Math.floor(mins / 60);
        if (hours < 24) return this.tf('ago_hour', {n: hours});
        return this.tf('ago_day', {n: Math.floor(hours / 24)});
    }

    _reloadI18n() {
        const lang = this._settings.get_string('language') || 'en';
        const en = loadLocale(this, 'en');
        const cur = lang === 'en' ? {} : loadLocale(this, lang);
        this._dict = {...en, ...cur};
        // Persian is right-to-left: mirror the whole settings window
        try {
            Gtk.Widget.set_default_direction(lang === 'fa' ? Gtk.TextDirection.RTL : Gtk.TextDirection.LTR);
        } catch (e) { /* ignore */ }
    }

    _switchRow(title, subtitle, key) {
        const row = new Adw.SwitchRow({title, subtitle: subtitle || ''});
        this._settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    // text entry that only saves on Enter / the apply button, and only when the value passes validate()
    _entryRow(title, help, key, validate) {
        const row = new Adw.EntryRow({
            title, show_apply_button: true, tooltip_text: help || '',
            text: this._settings.get_string(key),
        });
        row.connect('apply', () => {
            const v = row.get_text().trim();
            if (validate && !validate(v)) {
                row.add_css_class('error');
                this._toast(help);
                return;
            }
            row.remove_css_class('error');
            this._settings.set_string(key, v);
        });
        return row;
    }

    _updatePageTitles() {
        this._pageGeneral.title = this.t('prefs_general');
        this._pageSubs.title = this.t('prefs_subscriptions');
        this._pageRouting.title = this.t('prefs_routing');
        this._pageLogs.title = this.t('prefs_logs');
        this._pageAdv.title = this.t('prefs_advanced');
    }

    _stringCombo(title, subtitle, key, options) {
        const row = new Adw.ComboRow({title, subtitle: subtitle || ''});
        const model = new Gtk.StringList();
        for (const [, label] of options)
            model.append(label);
        row.model = model;
        const cur = this._settings.get_string(key);
        row.selected = Math.max(0, options.findIndex(o => o[0] === cur));
        row.connect('notify::selected', () => {
            this._settings.set_string(key, options[row.selected][0]);
        });
        return row;
    }

    _buildGeneral() {
        const about = new Adw.PreferencesGroup();
        const aboutRow = new Adw.ActionRow({
            title: 'Qurp',
            subtitle: this.metadata.description,
        });
        aboutRow.add_prefix(new Gtk.Image({icon_name: 'network-vpn-symbolic', pixel_size: 32}));
        const ver = new Gtk.Label({label: `v${this.metadata['version-name'] ?? this.metadata.version}`, valign: Gtk.Align.CENTER});
        ver.add_css_class('dim-label');
        ver.add_css_class('caption');
        aboutRow.add_suffix(ver);
        const fsBtn = new Gtk.ToggleButton({
            icon_name: 'view-fullscreen-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: `${this.t('fullscreen')} (F11)`,
        });
        fsBtn.add_css_class('flat');
        let syncing = false;
        fsBtn.connect('toggled', () => {
            if (!syncing && fsBtn.active !== this._window.fullscreened)
                this._toggleFullscreen();
        });
        this._window.connect('notify::fullscreened', () => {
            syncing = true;
            fsBtn.active = this._window.fullscreened;
            fsBtn.icon_name = this._window.fullscreened
                ? 'view-restore-symbolic' : 'view-fullscreen-symbolic';
            syncing = false;
        });
        aboutRow.add_suffix(fsBtn);
        about.add(aboutRow);
        this._pageGeneral.add(about);

        const ui = new Adw.PreferencesGroup({title: this.t('appearance')});
        const langRow = new Adw.ComboRow({title: this.t('language')});
        langRow.model = new Gtk.StringList();
        langRow.model.append('English');
        langRow.model.append('فارسی');
        langRow.model.append('中文');
        const map = ['en', 'fa', 'zh'];
        const cur = this._settings.get_string('language') || 'en';
        langRow.selected = Math.max(0, map.indexOf(cur));
        langRow.connect('notify::selected', () => {
            this._settings.set_string('language', map[langRow.selected] || 'en');
        });
        ui.add(langRow);
        this._pageGeneral.add(ui);
        this._buildPlacement();

        const conn = new Adw.PreferencesGroup({title: this.t('prefs_connection')});
        conn.add(this._stringCombo(this.t('connection_mode'), this.t('mode_help'), 'connection-mode', [
            ['proxy', this.t('mode_proxy')],
            ['tun', this.t('mode_tun')],
        ]));
        this._pageGeneral.add(conn);

        const startup = new Adw.PreferencesGroup({title: this.t('startup')});
        const auto = new Adw.SwitchRow({
            title: this.t('auto_connect'),
            subtitle: this.t('auto_connect_help'),
        });
        this._settings.bind('auto-connect', auto, 'active', Gio.SettingsBindFlags.DEFAULT);
        startup.add(auto);
        startup.add(this._switchRow(this.t('auto_connect_best'), this.t('auto_connect_best_help'), 'auto-connect-best'));
        startup.add(this._switchRow(this.t('auto_reconnect'), this.t('auto_reconnect_help'), 'auto-reconnect'));
        this._pageGeneral.add(startup);
    }

    // ---- Quick Settings tile position ---------------------------------------
    // The extension publishes the real tile order; fall back to a sketch until it has.
    _realTiles() {
        try {
            const list = JSON.parse(this._settings.get_string('tile-layout') || '[]');
            if (Array.isArray(list) && list.some(x => x.q))
                return list;
        } catch (e) { /* ignore */ }
        return null;
    }

    _placementState() {
        const real = this._realTiles();
        if (real)
            return {index: real.findIndex(x => x.q), total: real.length, real: true};
        const mode = this._settings.get_string('toggle-position') || 'below-wifi';
        const slot = this._settings.get_int('toggle-slot');
        const idx = {'below-wifi': 2, 'after-wifi': 1, 'start': 0, 'end': PLACE_CELLS - 1}[mode] ?? slot;
        return {index: Math.max(0, Math.min(idx, PLACE_CELLS - 1)), total: PLACE_CELLS, real: false};
    }

    _buildPlacement() {
        const group = new Adw.PreferencesGroup({
            title: this.t('toggle_position'),
            description: this.t('toggle_position_help'),
        });

        const modes = ['below-wifi', 'after-wifi', 'start', 'end', 'custom'];
        const combo = new Adw.ComboRow({title: this.t('toggle_position_preset')});
        const model = new Gtk.StringList();
        for (const m of modes)
            model.append(this.t(`pos_${m.replace('-', '_')}`));
        combo.model = model;
        this._placeCombo = combo;
        group.add(combo);

        const grid = new Gtk.Grid({
            column_spacing: 6, row_spacing: 6, column_homogeneous: true,
            margin_top: 8, margin_bottom: 4, hexpand: true,
        });
        this._placeGrid = grid;
        const wrap = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, hexpand: true,
            margin_start: 12, margin_end: 12,
        });
        wrap.append(grid);
        this._placeStatus = new Gtk.Label({wrap: true, xalign: 0, margin_top: 4, margin_bottom: 2});
        this._placeStatus.add_css_class('caption');
        wrap.append(this._placeStatus);
        const hint = new Gtk.Label({
            label: this.t('toggle_position_hint'), wrap: true, xalign: 0, margin_bottom: 8,
        });
        hint.add_css_class('dim-label');
        hint.add_css_class('caption');
        wrap.append(hint);
        group.add(new Adw.PreferencesRow({activatable: false, child: wrap}));

        const reset = new Gtk.Button({
            label: this.t('toggle_position_reset'), valign: Gtk.Align.CENTER,
        });
        const resetRow = new Adw.ActionRow({title: this.t('toggle_position_default')});
        resetRow.add_suffix(reset);
        reset.connect('clicked', () => {
            this._expectMove(2);
            this._settings.set_string('toggle-position', 'below-wifi');
            this._settings.set_int('toggle-slot', 2);
        });
        group.add(resetRow);

        this._placeBusy = false;
        combo.connect('notify::selected', () => {
            if (this._placeBusy)
                return;
            const m = modes[combo.selected] || 'below-wifi';
            if (m === 'custom')
                this._settings.set_int('toggle-slot', Math.max(0, this._placementState().index));
            this._settings.set_string('toggle-position', m);
        });

        const refresh = () => {
            this._placeBusy = true;
            combo.selected = Math.max(0, modes.indexOf(this._settings.get_string('toggle-position')));
            this._placeBusy = false;
            this._renderPlacement();
            this._confirmMove();
        };
        const sigs = ['toggle-position', 'toggle-slot', 'tile-layout'].map(k =>
            this._settings.connect(`changed::${k}`, refresh));
        this._window.connect('close-request', () => {
            for (const id of sigs)
                this._settings.disconnect(id);
            if (this._moveTimer) {
                GLib.source_remove(this._moveTimer);
                this._moveTimer = 0;
            }
            return false;
        });
        refresh();
        this._pageGeneral.add(group);
    }

    // Wait for the shell to report the new real position, then confirm with a toast.
    // If it never answers, the running shell is still on an old copy of the extension.
    _expectMove(target) {
        this._pendingMove = target;
        if (this._moveTimer)
            GLib.source_remove(this._moveTimer);
        this._moveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
            this._moveTimer = 0;
            if (this._pendingMove !== null && this._pendingMove !== undefined) {
                this._pendingMove = null;
                this._toast(this.t('move_no_reply'));
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _confirmMove() {
        if (this._pendingMove === null || this._pendingMove === undefined)
            return;
        const {index, real} = this._placementState();
        if (!real || index !== this._pendingMove)
            return;
        this._pendingMove = null;
        if (this._moveTimer) {
            GLib.source_remove(this._moveTimer);
            this._moveTimer = 0;
        }
        this._toast(this.tf('move_done', {n: index + 1}));
    }

    _toast(text) {
        try { this._window.add_toast(new Adw.Toast({title: text, timeout: 3})); }
        catch (e) { /* ignore */ }
    }

    // Miniature of the real Quick Settings grid. Click a tile to put Qurp there.
    _renderPlacement() {
        const grid = this._placeGrid;
        let child = grid.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            grid.remove(child);
            child = next;
        }
        const real = this._realTiles();
        const {index, total} = this._placementState();
        const tiles = real ?? Array.from({length: PLACE_CELLS}, (_x, i) => ({
            t: i === index ? 'Qurp' : (i < 2 ? ['Wi-Fi', 'Bluetooth'][i] : this.t('placement_tile')),
            q: i === index ? 1 : 0,
        }));
        tiles.forEach((tile, i) => {
            const btn = new Gtk.Button({label: tile.t, hexpand: true});
            btn.set_size_request(-1, 44);
            btn.add_css_class(tile.q ? 'suggested-action' : 'flat');
            if (!tile.q)
                btn.add_css_class('dim-label');
            btn.set_tooltip_text(`${i + 1}`);
            btn.connect('clicked', () => {
                if (i === index) {
                    this._toast(this.tf('move_already', {n: i + 1}));
                    return;
                }
                this._expectMove(i);
                this._settings.set_int('toggle-slot', i);
                this._settings.set_string('toggle-position', 'custom');
            });
            grid.attach(btn, i % 2, Math.floor(i / 2), 1, 1);
        });
        this._placeStatus.label = real
            ? this.tf('placement_now', {n: index + 1, total})
            : this.t('placement_unknown');
    }

    _intCombo(title, subtitle, key, values, fmt) {
        const row = new Adw.ComboRow({title, subtitle: subtitle || ''});
        const model = new Gtk.StringList();
        for (const v of values) model.append(fmt(v));
        row.model = model;
        const cur = this._settings.get_int(key);
        row.selected = Math.max(0, values.indexOf(cur));
        row.connect('notify::selected', () => this._settings.set_int(key, values[row.selected]));
        return row;
    }

    _buildSubs() {
        this._expandedRows = new Set();
        this._subsGroup = new Adw.PreferencesGroup({title: this.t('prefs_subscriptions')});

        const bar = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
        this._addBtn = new Gtk.Button({label: this.t('add_subscription')});
        this._addBtn.add_css_class('suggested-action');
        this._addBtn.connect('clicked', () => this._subDialog(null));
        this._bulkBtn = new Gtk.Button({label: this.t('bulk_add')});
        this._bulkBtn.connect('clicked', () => this._bulkDialog());
        const upd = new Gtk.Button({icon_name: 'view-refresh-symbolic', tooltip_text: this.t('update_all')});
        upd.connect('clicked', () => {
            this._requestUpdate('all');
            this._toast(this.t('updating'));
        });
        bar.append(this._addBtn);
        bar.append(this._bulkBtn);
        bar.append(upd);
        this._subsGroup.set_header_suffix(bar);
        this._pageSubs.add(this._subsGroup);

        const acc = new Adw.PreferencesGroup({title: this.t('accuracy')});
        acc.add(this._intCombo(this.t('ping_probes'), this.t('ping_probes_help'), 'ping-probes',
            [1, 3, 5], v => String(v)));
        acc.add(this._intCombo(this.t('stale_after'), this.t('stale_help'), 'ping-stale-minutes',
            [5, 10, 30, 60], v => this.tf('minutes', {n: v})));
        this._pageSubs.add(acc);

        const upd2 = new Adw.PreferencesGroup({title: this.t('auto_update')});
        upd2.add(this._intCombo(this.t('auto_update'), this.t('auto_update_help'), 'sub-update-hours',
            [0, 1, 3, 6, 12, 24],
            h => (h === 0 ? this.t('off') : this.tf('every_hours', {n: h}))));
        this._pageSubs.add(upd2);

        this._refreshSubsList();
        this._settings.connect('changed::subscriptions', () => this._refreshSubsList());
        this._watchFiles();
        this._window.connect('close-request', () => {
            for (const m of this._monitors ?? []) m.cancel();
            if (this._refreshTimer) GLib.source_remove(this._refreshTimer);
            return false;
        });
    }

    // the extension writes status and usage files; keep the page live without a restart
    _watchFiles() {
        this._monitors = [];
        for (const path of [CACHE_FILE, USAGE_FILE]) {
            try {
                const m = Gio.File.new_for_path(path).monitor_file(Gio.FileMonitorFlags.NONE, null);
                m.connect('changed', () => {
                    if (this._refreshTimer) GLib.source_remove(this._refreshTimer);
                    this._refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                        this._refreshTimer = 0;
                        this._refreshSubsList();
                        return GLib.SOURCE_REMOVE;
                    });
                });
                this._monitors.push(m);
            } catch (e) { /* monitoring is optional */ }
        }
    }

    _requestUpdate(id) {
        this._settings.set_string('update-request', `${id}|${Date.now()}`);
    }

    _buildRouting() {
        const preset = new Adw.PreferencesGroup({title: this.t('routing_preset')});
        preset.add(this._stringCombo(this.t('routing_preset'), '', 'routing-preset', [
            ['global', this.t('preset_global')],
            ['ir-bypass', this.t('preset_ir')],
        ]));
        this._pageRouting.add(preset);

        const rules = new Adw.PreferencesGroup({
            title: this.t('routing_rules'),
            description: this.t('routing_help'),
        });
        for (const [key, label] of [
            ['routing-direct-domains', 'routing_direct_domains'],
            ['routing-direct-ips', 'routing_direct_ips'],
            ['routing-block-domains', 'routing_block_domains'],
            ['routing-direct-apps', 'routing_direct_apps'],
        ]) {
            const row = new Adw.EntryRow({title: this.t(label)});
            this._settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
            rules.add(row);
        }
        this._pageRouting.add(rules);
    }

    _getSubs() {
        try {
            const arr = JSON.parse(this._settings.get_string('subscriptions') || '[]');
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            return [];
        }
    }

    _setSubs(subs) {
        // metadata only — never embed full server lists (causes hang / GSettings size issues)
        const meta = subs.map(s => ({
            id: s.id,
            name: s.name,
            url: s.url,
            enabled: s.enabled !== false,
        }));
        this._settings.set_string('subscriptions', JSON.stringify(meta));
    }

    _refreshSubsList() {
        for (const r of this._subRows ?? [])
            this._subsGroup.remove(r);
        this._subRows = [];
        const add = r => { this._subsGroup.add(r); this._subRows.push(r); };

        const metas = this._getSubs();
        const seen = new Set();
        const subs = [];
        for (const m of metas) {
            if (!m.url || seen.has(m.url)) continue;
            seen.add(m.url);
            subs.push(m);
        }
        if (subs.length !== metas.length)
            this._setSubs(subs);

        const cache = readJson(CACHE_FILE);
        const usage = readJson(USAGE_FILE);
        const active = subs.filter(x => x.enabled !== false).length;
        this._subsGroup.description = `${this.tf('subs_counter', {n: subs.length})} · ${this.tf('active_count', {n: active})}`;
        const full = subs.length >= MAX_SUBS;
        this._addBtn.sensitive = !full;
        this._bulkBtn.sensitive = !full;

        if (!subs.length) {
            const empty = new Adw.ActionRow({title: this.t('no_servers'), subtitle: this.t('subs_empty_hint')});
            empty.add_prefix(new Gtk.Image({icon_name: 'folder-download-symbolic', pixel_size: 24}));
            add(empty);
            return;
        }

        subs.forEach((m, idx) => {
            const c = cache[m.id] || {};
            const sub = {...m, traffic: c.traffic ?? null, updatedAt: c.updatedAt ?? null, error: c.error ?? null};
            const count = (c.servers || []).length;
            const health = subHealth(sub);
            const esc = x => GLib.markup_escape_text(String(x), -1);

            const row = new Adw.ExpanderRow({
                title: esc(m.name || 'Sub'),
                subtitle: esc(`${hostOf(m.url)} · ${count} ${this.t('servers')} · ${this.t(`status_${health}`)}`),
            });
            const [icon, cls] = HEALTH_ICON[health];
            const img = new Gtk.Image({icon_name: icon});
            img.add_css_class(cls);
            row.add_prefix(img);

            const sw = new Gtk.Switch({active: m.enabled !== false, valign: Gtk.Align.CENTER});
            sw.connect('notify::active', () => {
                const list = this._getSubs();
                const t = list.find(x => x.id === m.id);
                if (t) {
                    t.enabled = sw.active;
                    this._setSubs(list);
                }
            });
            row.add_suffix(sw);

            // usage as reported by the provider
            const tr = sub.traffic;
            const usageRow = new Adw.ActionRow({title: this.t('usage_provider')});
            if (tr) {
                usageRow.subtitle = tr.total > 0
                    ? `${formatBytes(tr.used)} / ${formatBytes(tr.total)}`
                    : `${formatBytes(tr.used)} · ${this.t('unlimited')}`;
                if (tr.total > 0) {
                    const bar2 = new Gtk.ProgressBar({
                        fraction: Math.max(0, Math.min(1, tr.used / tr.total)),
                        valign: Gtk.Align.CENTER, width_request: 140,
                    });
                    usageRow.add_suffix(bar2);
                }
            } else {
                usageRow.subtitle = '—';
            }
            row.add_row(usageRow);

            let expText = '—';
            if (tr?.expire) {
                const dt = GLib.DateTime.new_from_unix_local(tr.expire);
                const days = Math.ceil((tr.expire * 1000 - Date.now()) / 86400000);
                expText = `${dt.format('%Y-%m-%d')} · ${days < 0 ? this.t('expired') : this.tf('days_left', {n: days})}`;
            }
            row.add_row(new Adw.ActionRow({title: this.t('expires'), subtitle: esc(expText)}));

            row.add_row(new Adw.ActionRow({
                title: this.t('last_update'),
                subtitle: esc(sub.error ? `${this.t('update_failed')}: ${sub.error}` : this.ago(sub.updatedAt)),
            }));

            const u = usage[m.id];
            row.add_row(new Adw.ActionRow({
                title: this.t('measured_here'),
                subtitle: u ? esc(`↓ ${formatBytes(u.down)}  ↑ ${formatBytes(u.up)}`) : '—',
            }));

            // actions
            const actions = new Adw.ActionRow({title: this.t('actions')});
            const box = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 4, valign: Gtk.Align.CENTER});
            const mk = (iconName, tip, fn, css) => {
                const b = new Gtk.Button({icon_name: iconName, tooltip_text: tip});
                b.add_css_class('flat');
                if (css) b.add_css_class(css);
                b.connect('clicked', fn);
                box.append(b);
                return b;
            };
            mk('document-edit-symbolic', this.t('edit'), () => this._subDialog(m));
            mk('view-refresh-symbolic', this.t('updating'), () => {
                this._requestUpdate(m.id);
                this._toast(`${this.t('updating')} ${m.name}`);
            });
            const up = mk('go-up-symbolic', this.t('move_up'), () => this._moveSub(m.id, -1));
            const down = mk('go-down-symbolic', this.t('move_down'), () => this._moveSub(m.id, 1));
            up.sensitive = idx > 0;
            down.sensitive = idx < subs.length - 1;
            mk('user-trash-symbolic', this.t('delete_sub'), () => this._confirmDelete(m), 'destructive-action');
            actions.add_suffix(box);
            row.add_row(actions);

            row.expanded = this._expandedRows.has(m.id);
            row.connect('notify::expanded', () => {
                if (row.expanded) this._expandedRows.add(m.id);
                else this._expandedRows.delete(m.id);
            });
            add(row);
        });
    }

    _moveSub(id, delta) {
        const list = this._getSubs();
        const i = list.findIndex(x => x.id === id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        this._setSubs(list);
    }

    _confirmDelete(sub) {
        const dialog = new Adw.AlertDialog({
            heading: this.t('delete_confirm'),
            body: `${sub.name || 'Sub'} · ${hostOf(sub.url)}`,    // AlertDialog bodies are plain text
        });
        dialog.add_response('cancel', this.t('cancel'));
        dialog.add_response('delete', this.t('delete_sub'));
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.connect('response', (_d, r) => {
            if (r === 'delete')
                this._setSubs(this._getSubs().filter(x => x.id !== sub.id));
        });
        dialog.present(this._window);
    }

    _bulkDialog() {
        const dialog = new Adw.AlertDialog({
            heading: this.t('bulk_add'),
            body: this.t('bulk_help'),
        });
        const tv = new Gtk.TextView({
            wrap_mode: Gtk.WrapMode.WORD_CHAR, monospace: true,
            top_margin: 8, bottom_margin: 8, left_margin: 10, right_margin: 10,
        });
        const sc = new Gtk.ScrolledWindow({min_content_height: 150, min_content_width: 360, child: tv});
        sc.add_css_class('card');
        dialog.set_extra_child(sc);
        dialog.add_response('cancel', this.t('cancel'));
        dialog.add_response('add', this.t('add_subscription'));
        dialog.set_response_appearance('add', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_d, r) => {
            if (r !== 'add') return;
            const text = tv.buffer.get_text(tv.buffer.get_start_iter(), tv.buffer.get_end_iter(), false);
            this._bulkAdd(text);
        });
        dialog.present(this._window);
    }

    _bulkAdd(text) {
        const list = this._getSubs();
        const have = new Set(list.map(x => x.url));
        const names = new Set(list.map(x => x.name));
        let added = 0, dup = 0, invalid = 0, over = 0;
        let n = 0;
        for (const line of text.split(/\r?\n/)) {
            const url = line.trim();
            if (!url) continue;
            if (!/^https?:\/\/\S+$/i.test(url)) { invalid++; continue; }
            if (have.has(url)) { dup++; continue; }
            if (list.length >= MAX_SUBS) { over++; continue; }
            let name = hostOf(url);
            for (let k = 2; names.has(name); k++) name = `${hostOf(url)} ${k}`;
            names.add(name);
            have.add(url);
            list.push({id: `sub_${Date.now()}_${n++}`, name, url, enabled: true});
            added++;
        }
        if (added) this._setSubs(list);
        this._toast(this.tf('bulk_result', {a: added, d: dup, i: invalid, l: over}));
    }

    _subDialog(editing) {
        const existing = this._getSubs();
        if (!editing && existing.length >= MAX_SUBS)
            return;

        const dialog = new Adw.AlertDialog({
            heading: this.t(editing ? 'edit_subscription' : 'add_subscription'),
        });
        const group = new Adw.PreferencesGroup();
        const nameRow = new Adw.EntryRow({title: this.t('name'), text: editing?.name ?? ''});
        const urlRow = new Adw.EntryRow({title: this.t('url'), text: editing?.url ?? ''});
        group.add(nameRow);
        group.add(urlRow);
        const hint = new Gtk.Label({
            label: this.t('url_invalid'), xalign: 0, wrap: true, margin_top: 6, visible: false,
        });
        hint.add_css_class('error');
        hint.add_css_class('caption');
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, margin_top: 8});
        box.append(group);
        box.append(hint);
        dialog.set_extra_child(box);

        dialog.add_response('cancel', this.t('cancel'));
        dialog.add_response('save', this.t('save'));
        dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('save');

        const valid = () => /^https?:\/\/\S+$/i.test(urlRow.get_text().trim());
        const sync = () => {
            const ok = valid();
            dialog.set_response_enabled('save', ok);
            hint.visible = !ok && urlRow.get_text().trim().length > 0;
        };
        urlRow.connect('changed', sync);
        sync();

        dialog.connect('response', (_d, response) => {
            if (response !== 'save' || !valid())
                return;
            const u = urlRow.get_text().trim();
            const n = nameRow.get_text().trim();
            const subs = this._getSubs();
            if (editing) {
                const target = subs.find(x => x.id === editing.id);
                if (target) {
                    target.url = u;
                    target.name = n || target.name;
                }
            } else {
                const dup = subs.find(x => x.url === u);
                if (dup) {
                    if (n) dup.name = n;
                } else if (subs.length < MAX_SUBS) {
                    subs.push({id: `sub_${Date.now()}`, name: n || `Sub ${subs.length + 1}`, url: u, enabled: true});
                }
            }
            this._setSubs(subs);
        });
        dialog.present(this._window);
    }

    _buildLogs() {
        const group = new Adw.PreferencesGroup({
            title: this.t('prefs_logs'),
            description: GLib.markup_escape_text(LOG_FILE, -1),
        });

        const mkBtn = (icon, tip, fn) => {
            const b = new Gtk.Button({icon_name: icon, tooltip_text: tip, valign: Gtk.Align.CENTER});
            b.add_css_class('flat');
            b.connect('clicked', fn);
            return b;
        };
        const bar = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 2});
        bar.append(mkBtn('view-refresh-symbolic', this.t('reload_logs'), () => this._loadLogs()));
        bar.append(mkBtn('edit-copy-symbolic', this.t('copy'), () => {
            this._window.get_display().get_clipboard().set(this._logView.buffer.text);
            this._window.add_toast(new Adw.Toast({title: this.t('logs_copied'), timeout: 2}));
        }));
        const clear = mkBtn('edit-clear-all-symbolic', this.t('clear_logs'), () => {
            try {
                Gio.File.new_for_path(LOG_FILE).replace_contents(
                    '', null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
                );
            } catch (e) { /* ignore */ }
            this._logView.buffer.text = '';
        });
        clear.add_css_class('destructive-action');
        bar.append(clear);
        group.set_header_suffix(bar);

        const scrolled = new Gtk.ScrolledWindow({min_content_height: 320, vexpand: true});
        scrolled.add_css_class('card');
        this._logView = new Gtk.TextView({
            editable: false,
            monospace: true,
            cursor_visible: false,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            top_margin: 10, bottom_margin: 10, left_margin: 12, right_margin: 12,
        });
        scrolled.set_child(this._logView);
        group.add(scrolled);

        this._pageLogs.add(group);
        this._loadLogs();
    }

    _loadLogs() {
        try {
            const [ok, contents] = Gio.File.new_for_path(LOG_FILE).load_contents(null);
            this._logView.buffer.text = ok
                ? new TextDecoder().decode(contents)
                : '';
        } catch (e) {
            this._logView.buffer.text = '';
        }
    }

    _buildAdvanced() {
        const protect = new Adw.PreferencesGroup({title: this.t('prefs_protection')});

        const exitIp = new Adw.SwitchRow({
            title: this.t('exit_ip_check'),
        });
        this._settings.bind('exit-ip-check', exitIp, 'active', Gio.SettingsBindFlags.DEFAULT);
        protect.add(exitIp);

        const helperOk = GLib.file_test('/usr/local/libexec/qurp-helper', GLib.FileTest.IS_EXECUTABLE);
        const kill = new Adw.SwitchRow({
            title: this.t('kill_switch'),
            subtitle: helperOk ? this.t('kill_switch_help') : this.t('helper_missing'),
            sensitive: helperOk,
        });
        this._settings.bind('kill-switch', kill, 'active', Gio.SettingsBindFlags.DEFAULT);
        protect.add(kill);

        const dns = new Adw.SwitchRow({
            title: this.t('dns_leak'),
            subtitle: this.t('dns_help'),
        });
        this._settings.bind('dns-leak-protection', dns, 'active', Gio.SettingsBindFlags.DEFAULT);
        protect.add(dns);

        const tls = new Adw.SwitchRow({
            title: this.t('tls_skip_verify'),
            subtitle: this.t('tls_skip_help'),
        });
        this._settings.bind('tls-skip-verify', tls, 'active', Gio.SettingsBindFlags.DEFAULT);
        protect.add(tls);
        protect.add(this._switchRow(this.t('tls_fragment'), this.t('tls_fragment_help'), 'tls-fragment'));

        const net = new Adw.PreferencesGroup({title: this.t('prefs_network')});

        const port = new Adw.SpinRow({
            title: this.t('proxy_port'),
            adjustment: new Gtk.Adjustment({
                lower: 1024, upper: 65535, step_increment: 1, value: 2080,
            }),
        });
        this._settings.bind('proxy-port', port, 'value', Gio.SettingsBindFlags.DEFAULT);
        net.add(port);

        net.add(this._stringCombo(this.t('ping_mode'), '', 'ping-mode', [
            ['real', this.t('ping_real')],
            ['tcp', this.t('ping_tcp')],
        ]));

        const ping = new Adw.SpinRow({
            title: this.t('ping_timeout'),
            adjustment: new Gtk.Adjustment({
                lower: 500, upper: 15000, step_increment: 100, value: 3000,
            }),
        });
        this._settings.bind('ping-timeout', ping, 'value', Gio.SettingsBindFlags.DEFAULT);
        net.add(ping);

        const isIp = v => /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]+:[0-9a-fA-F:]*)$/.test(v);
        net.add(this._entryRow(this.t('dns_bootstrap'), this.t('dns_bootstrap_help'), 'dns-bootstrap', isIp));
        net.add(this._entryRow(this.t('dns_remote'), this.t('dns_remote_help'), 'dns-remote', isIp));
        net.add(this._entryRow(this.t('sub_user_agent'), this.t('sub_user_agent_help'), 'sub-user-agent',
            v => v.length <= 80 && !/[\r\n]/.test(v)));
        net.add(this._switchRow(this.t('check_updates'), this.t('check_updates_help'), 'check-updates'));
        net.add(this._switchRow(this.t('core_log_verbose'), this.t('core_log_verbose_help'), 'core-log-verbose'));

        this._pageAdv.add(protect);
        this._pageAdv.add(net);
    }
}
