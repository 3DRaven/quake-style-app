// Quake Style App — extension behaviour, a normal ES module bundled with the
// extension. The lifecycle entry points enable(ext) / disable() are at the bottom;
// everything between is plain module-level functions and state.

import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// --- Session state + settings --------------------------------------------------
// `state` holds long-lived objects for the active session; enable() resets it and
// cleanup() tears it down. `_settings`/`extPath` are provided by enable(ext).
let state = {};
let _settings = null;
let extPath = '';
function settings() { return _settings; }

// One-shot GLib timeout tracked in state.timers so cleanup() can drop any that are
// still pending when the extension is disabled (no callback fires on a torn-down state).
function addTimeout(ms, fn) {
    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        state.timers.delete(id);
        return fn();
    });
    state.timers.add(id);
    return id;
}

const cfg = {
    command:  () => { const s = settings(); return s ? s.get_string('command')         : 'foot --app-id=quake-style-app --title=dropdown'; },
    appId:    () => { const s = settings(); return s ? s.get_string('app-id')          : 'quake-style-app'; },
    heightF:  () => { const s = settings(); return s ? s.get_double('height-fraction') : 0.65; },
    widthF:   () => { const s = settings(); return s ? s.get_double('width-fraction')  : 1.0; },
    position: () => { const s = settings(); return s ? s.get_string('position')        : 'top'; },
    useTmux:  () => { const s = settings(); return s ? s.get_boolean('use-tmux')        : false; },
    session:  () => { const s = settings(); return s ? s.get_string('tmux-session')     : 'dropdown'; },
    barPos:     () => { const s = settings(); return s ? s.get_string('bar-position')   : 'top'; },
    barHeight:  () => { const s = settings(); return s ? s.get_int('bar-height')        : 60; },
    barColor:   () => { const s = settings(); return s ? s.get_string('bar-color')      : '#0d0208'; },
    activeColor:() => { const s = settings(); return s ? s.get_string('active-color')   : '#44475A'; },
    textColor:  () => { const s = settings(); return s ? s.get_string('text-color')     : '#F8F8F2'; },
    onClose:    () => { const s = settings(); return s ? s.get_string('on-window-close') : 'detach'; },
    fillBg:     () => { const s = settings(); return s ? s.get_boolean('fill-background')  : false; },
    fillColor:  () => { const s = settings(); return s ? s.get_string('fill-color')        : '#0d0208'; },
    icon:       () => { try { const s = settings(); return s ? s.get_string('icon') : ''; } catch (_e) { return ''; } },
};

// The window's icon comes from a .desktop matched by app-id. We (re)generate it with the
// chosen icon, or — by default — the launched app's OWN icon, read from its .desktop.
// This .desktop is NoDisplay (it only carries the window icon, matched by app-id) and
// is never launched, but a Type=Application entry still requires a valid Exec.
const DESKTOP_EXEC = 'true';
// Read "Icon=" from <desktopId> in the XDG application dirs, via GLib.KeyFile. Avoids
// DesktopAppInfo entirely (deprecated as Gio.*, and GioUnix.* is absent on GLib < 2.80
// i.e. GNOME 45); KeyFile is stable on every version. Empty if not found.
function desktopIcon(desktopId) {
    const rel = GLib.build_filenamev(['applications', desktopId]);
    for (const dir of [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]) {
        const path = GLib.build_filenamev([dir, rel]);
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            continue;
        const kf = new GLib.KeyFile();
        try {
            kf.load_from_file(path, GLib.KeyFileFlags.NONE);
            const icon = kf.get_string('Desktop Entry', 'Icon');
            if (icon)
                return icon;
        } catch (_e) { /* malformed or no Icon key — keep scanning */ }
    }
    return '';
}
// The launched app's own icon (e.g. "foot" -> foot.desktop -> "foot"). Empty if the app
// has no discoverable .desktop (name != binary) — caller falls back to ours.
function nativeIcon(command) {
    try {
        const [ok, argv] = GLib.shell_parse_argv(command);
        if (ok && argv.length)
            return desktopIcon(`${GLib.path_get_basename(argv[0])}.desktop`);
    } catch (_e) { /* bad command — fall back to our own icon */ }
    return '';
}
function ensureDesktop() {
    const appId = cfg.appId();
    const setting = cfg.icon();
    const command = cfg.command();
    // Cache on the cheap inputs so the .desktop write AND the DesktopAppInfo lookup
    // run only when something actually changed (once per session), not on every show.
    const key = `${appId}|${setting}|${command}`;
    if (state.desktopKey === key)
        return;
    state.desktopKey = key;
    const icon = setting || nativeIcon(command) || 'quake-style-app';
    try {
        const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'applications']);
        GLib.mkdir_with_parents(dir, 0o755);
        const content =
            '[Desktop Entry]\nType=Application\nName=Quake Style App\n' +
            `Icon=${icon}\nStartupWMClass=${appId}\nNoDisplay=true\nTerminal=false\n` +
            `Exec=${DESKTOP_EXEC}\n`;
        GLib.file_set_contents(GLib.build_filenamev([dir, `${appId}.desktop`]), content);
    } catch (_e) { /* keep whatever .desktop already exists */ }
}

// A solid backing across the whole dropdown rect, placed just below the terminal
// window (in window_group), so any quantization gap shows our color, not the desktop.
function ensureFill() {
    if (state.fill)
        return state.fill;
    const f = new St.Widget({reactive: false});
    global.window_group.add_child(f);
    const first = global.window_group.get_first_child();
    if (first && first !== f)
        global.window_group.set_child_below_sibling(f, first);   // start at the bottom
    f.hide();
    state.fill = f;
    return f;
}
function fillBelow(win) {
    if (!state.fill)
        return;
    const actor = win.get_compositor_private();
    if (actor && actor.get_parent() === global.window_group)
        global.window_group.set_child_below_sibling(state.fill, actor);
}
// Actually reveal the backing (geometry already set) and keep it just below the
// terminal.
function showFillNow(win) {
    const f = state.fill;
    if (!f)
        return;
    f.show();
    fillBelow(win);
    // The window actor may not be in window_group yet right after map; re-assert once
    // it settles so the fill ends up just below the terminal, not on top of it.
    addTimeout(250, () => { fillBelow(win); return GLib.SOURCE_REMOVE; });
}
// Cancel a pending deferred reveal (used when the window hides before it fired).
function cancelFillReveal() {
    if (state.fillLaterId) {
        const laters = global.compositor?.get_laters?.();
        if (laters)
            laters.remove(state.fillLaterId);
        state.fillLaterId = 0;
    }
}
// Reveal the fill only AFTER the terminal is on screen and done animating in, so the
// backing is never drawn before the window content. We poll once per redraw (frame-
// paced) until the window actor is at full scale/opacity, then show the fill the same
// frame the terminal is painted at rest — capped so we never wait forever.
function revealFillWhenSettled(win) {
    if (state.fillLaterId)
        return;
    const laters = global.compositor?.get_laters?.();
    if (!laters) {                 // no compositor laters available -> best-effort show
        showFillNow(win);
        return;
    }
    let frames = 0;
    state.fillLaterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
        const w = findWindow();
        if (!cfg.fillBg() || !w || w.minimized || !state.winRect) {
            state.fillLaterId = 0;
            if (state.fill)
                state.fill.hide();
            return GLib.SOURCE_REMOVE;
        }
        const actor = w.get_compositor_private();
        if (actor && frames++ < 60 &&
            (actor.scale_x < 0.999 || actor.scale_y < 0.999 || actor.opacity < 255))
            return GLib.SOURCE_CONTINUE;   // still animating in -> wait another frame
        state.fillLaterId = 0;
        showFillNow(w);
        return GLib.SOURCE_REMOVE;
    });
}
function updateFill(win) {
    if (!cfg.fillBg() || !win || win.minimized || !state.winRect) {
        cancelFillReveal();
        if (state.fill)
            state.fill.hide();
        return;
    }
    const f = ensureFill();
    const r = state.winRect;
    f.set_style(`background-color: ${cfg.fillColor()};`);
    f.set_position(r.x, r.y);
    f.set_size(r.w, r.h);
    if (f.visible) {
        fillBelow(win);            // already shown: just keep z-order/geometry current
        return;
    }
    revealFillWhenSettled(win);    // hidden: draw the terminal first, then the fill
}
function destroyFill() {
    cancelFillReveal();
    if (state.fill) {
        state.fill.destroy();
        state.fill = null;
    }
}

// Watch the foot window so closing it (Alt+F4) tears the bar down + optionally kills
// the tmux session, instead of leaving a stale/hung bar.
function watch(win) {
    if (state.watchedWin === win)
        return;
    unwatch();
    state.watchedWin = win;
    state.unmanagedId = win.connect('unmanaged', onClosed);
}
function unwatch() {
    if (state.watchedWin && state.unmanagedId) {
        try { state.watchedWin.disconnect(state.unmanagedId); } catch (_e) { /* already gone */ }
    }
    state.watchedWin = null;
    state.unmanagedId = 0;
}
function onClosed() {
    unwatch();
    state.spawnPid = 0;
    state.spawning = false;
    state.barOn = false;
    destroyBar();
    destroyFill();
    if (cfg.useTmux() && cfg.onClose() === 'kill')
        tmux(['kill-session', '-t', cfg.session()]);
}

const TMUX_SOCKET = 'quake-style-app';   // private tmux server, isolated from yours

// Inline style for the bar background + the edge facing the terminal.
function barStyle() {
    const edge = cfg.barPos() === 'bottom' ? 'border-top' : 'border-bottom';
    return `background-color: ${cfg.barColor()}; ${edge}: 1px solid #1c1c1c;`;
}

// Swap to a hover style while the pointer is over an actor (visual feedback).
function withHover(actor, base, hover) {
    actor.track_hover = true;
    const apply = () => actor.set_style(base + (actor.hover ? hover : ''));
    apply();
    actor.connect('notify::hover', apply);
}

// Lighten a #rrggbb colour by `amt` (0-255) per channel — used for hover highlights.
function lighten(hex, amt) {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
    if (!m)
        return hex;
    const n = parseInt(m[1], 16);
    const c = i => Math.min(255, ((n >> (i * 8)) & 0xff) + amt);
    return `#${((c(2) << 16) | (c(1) << 8) | c(0)).toString(16).padStart(6, '0')}`;
}

// Write the user's extra tmux config (from settings) to an isolated file that our
// shipped tmux.conf source-files. Everything stays within the extension; the host
// ~/.tmux.conf is never touched.
function writeTmuxExtra() {
    try {
        const s = settings();
        const extra = s ? s.get_string('tmux-config') : '';
        const dir = GLib.build_filenamev([GLib.get_user_config_dir(), 'quake-style-app']);
        GLib.mkdir_with_parents(dir, 0o700);
        GLib.file_set_contents(GLib.build_filenamev([dir, 'tmux-extra.conf']), (extra || '') + '\n');
    } catch (_e) {
        // the dropdown still works without extra config
    }
}

// --- Window matching -----------------------------------------------------------
function isMine(w) {
    const appId = cfg.appId().toLowerCase();
    const cls = (w.get_wm_class() || '').toLowerCase();
    const inst = (w.get_wm_class_instance() || '').toLowerCase();
    return cls === appId || inst === appId ||
        (state.spawnPid && w.get_pid() === state.spawnPid);
}

function findWindow() {
    const list = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null);
    return list.find(w => isMine(w)) ?? null;
}

// --- Placement -----------------------------------------------------------------
// A fraction of the monitor, top/bottom, centered. When the tab bar is on, reserve
// BAR_H at the top of that area for the bar and shrink the window by the same.
function place(win) {
    const mon = Main.layoutManager.primaryMonitor;
    if (!mon || !win)
        return;
    // Full monitor width, but vertical bounds from the WORK AREA so we sit below the
    // GNOME top panel (and above a bottom panel), not behind it.
    const wa = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
    const w = Math.round(mon.width * cfg.widthF());
    const fullH = Math.round(wa.height * cfg.heightF());
    const x = mon.x + Math.round((mon.width - w) / 2);
    const top = cfg.position() === 'bottom' ? wa.y + wa.height - fullH : wa.y;
    const barH = state.barOn ? cfg.barHeight() : 0;
    const barBottom = cfg.barPos() === 'bottom';
    win.move_resize_frame(false, x, barBottom ? top : top + barH, w, fullH - barH);
    if (state.barOn && state.bar) {
        state.bar.set_position(x, barBottom ? top + fullH - barH : top);
        state.bar.set_size(w, barH);
    }
    state.winRect = {x, y: barBottom ? top : top + barH, w, h: fullH - barH};
    updateFill(win);
}

function clearShowing() {
    addTimeout(250, () => {
        state.showing = false;
        return GLib.SOURCE_REMOVE;
    });
}

// Suppress auto-hide briefly (used when interacting with our own tab bar, so the
// foot window losing focus to the bar does not minimize the dropdown).
function suppressHide() {
    state.showing = true;
    clearShowing();
}

// --- Native tab bar (a thin front-end over tmux) -------------------------------
function ensureBar() {
    if (state.bar)
        return state.bar;
    // Structure: [ ‹ ] [ ScrollView(tabs) ] [ › ]. The scroll lets the wheel pan the
    // tabs; the ‹ › buttons appear only on overflow (no visible scrollbar).
    const outer = new St.BoxLayout({reactive: true, style_class: 'quake-tab-bar'});
    outer.set_style(barStyle());
    outer.connect('button-press-event', () => { suppressHide(); return Clutter.EVENT_PROPAGATE; });

    const mkArrow = (label, dir) => {
        const b = new St.Button({label, can_focus: false, y_expand: true});
        withHover(b, `padding: 0 12px; color: ${cfg.textColor()}; font-size: 16pt;`, 'background-color: rgba(255,255,255,0.12);');
        b.connect('clicked', () => { suppressHide(); scrollBy(dir); });
        // Always reserve the slot (so the scroll never runs under it); light up only on
        // overflow via opacity/reactive in updateArrows().
        b.opacity = 0;
        b.reactive = false;
        return b;
    };
    const left = mkArrow('‹', -1);
    const scroll = new St.ScrollView({reactive: true, x_expand: true, y_expand: true});
    scroll.set_policy(St.PolicyType.EXTERNAL, St.PolicyType.NEVER);
    const box = new St.BoxLayout({reactive: true, y_expand: true, style: 'padding: 0 2px;'});
    scroll.set_child(box);
    const right = mkArrow('›', 1);

    // The + is pinned to the right edge (outside the scroll), always visible.
    const plus = new St.Button({label: '+', reactive: true, can_focus: false, y_expand: true});
    withHover(plus, `padding: 0 14px; color: ${cfg.textColor()}; font-size: 16pt; font-weight: bold;`, 'background-color: rgba(255,255,255,0.12);');
    plus.connect('clicked', () => { suppressHide(); newTab(); });

    outer.add_child(left);
    outer.add_child(scroll);
    outer.add_child(right);
    outer.add_child(plus);
    Main.layoutManager.addChrome(outer, {affectsStruts: false});
    // Layer the bar like the terminal window: addChrome puts it on TOP of uiGroup, above
    // the dash/dock, so it paints over the Ubuntu Dock. Lower it to just above the
    // windows (global.window_group) instead — that keeps it over the terminal but UNDER
    // the dock and panel, which sit higher in uiGroup, exactly like the terminal sits.
    const ui = Main.layoutManager.uiGroup;
    if (global.window_group.get_parent() === ui)
        ui.set_child_above_sibling(outer, global.window_group);
    outer.hide();

    scroll.hadjustment.connect('changed', updateArrows);
    scroll.hadjustment.connect('notify::value', updateArrows);

    state.bar = outer;
    state.barScroll = scroll;
    state.barBox = box;
    state.barLeft = left;
    state.barRight = right;
    state.barPlus = plus;
    return outer;
}

function scrollBy(dir) {
    if (!state.barScroll)
        return;
    const a = state.barScroll.hadjustment;
    const step = a.page_size * 0.8;
    a.value = Math.max(a.lower, Math.min(a.upper - a.page_size, a.value + dir * step));
}

// Show ‹ › only when the tabs overflow, and dim the one at the end of its travel.
function updateArrows() {
    if (!state.barScroll)
        return;
    const a = state.barScroll.hadjustment;
    const overflow = a.upper - a.page_size > 1;
    const set = (arrow, enabled) => {
        arrow.reactive = enabled;
        arrow.opacity = enabled ? 255 : 0;
    };
    set(state.barLeft, overflow && a.value > a.lower + 1);
    set(state.barRight, overflow && a.value < a.upper - a.page_size - 1);
}

function hideBar() {
    if (state.bar)
        state.bar.hide();
    closeTabMenu();
}

function destroyBar() {
    closeTabMenu();
    if (!state.bar)
        return;
    Main.layoutManager.removeChrome(state.bar);
    state.bar.destroy();
    state.bar = null;
    state.barBox = null;
    state.barScroll = null;
    state.barLeft = null;
    state.barRight = null;
    state.barPlus = null;
}

const MIN_TAB_W = 140;   // px; below this tabs stop shrinking and the bar scrolls
const MAX_NAME = 12;     // cap the tab name so it always fits its tab

function tabLabel(t) {
    const name = t.name.length > MAX_NAME ? `${t.name.slice(0, MAX_NAME - 1)}…` : t.name;
    return `${t.index}: ${name}`;
}

function tabButton(t, width) {
    const active = t.active;
    const fg = cfg.textColor();   // active tab is shown by its background, not text color
    // The tab is a row [ label | × ] so the × can close just this window.
    const tab = new St.BoxLayout({reactive: true, y_expand: true});
    tab.set_width(width);
    const tabBase = `margin: 4px 2px; border-radius: 5px 5px 0 0; ` +
                    `background-color: ${active ? cfg.activeColor() : 'transparent'};`;
    const tabHover = `background-color: ${active ? lighten(cfg.activeColor(), 22) : 'rgba(255,255,255,0.08)'};`;
    withHover(tab, tabBase, tabHover);

    const label = new St.Button({label: tabLabel(t), reactive: true, can_focus: false, x_expand: true, y_expand: true});
    label.set_style(`padding: 0 2px 0 12px; font-size: 13pt; color: ${fg};`);
    label.connect('clicked', () => {
        suppressHide();
        closeTabMenu();
        tmux(['select-window', '-t', `${cfg.session()}:${t.index}`]);
    });
    label.connect('button-press-event', (_a, event) => {
        if (event.get_button() === 3) {           // right click -> context menu at the cursor
            const [ex, ey] = event.get_coords();
            showTabMenu(t, ex, ey);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    });

    const close = new St.Button({label: '×', reactive: true, can_focus: false, y_expand: true});
    withHover(close, `padding: 0 12px; font-size: 13pt; color: ${fg};`, 'background-color: rgba(0,0,0,0.28); border-radius: 4px;');
    close.connect('clicked', () => { suppressHide(); tmux(['kill-window', '-t', `${cfg.session()}:${t.index}`]); });

    tab.add_child(label);
    tab.add_child(close);
    return tab;
}

function renderTabs(tabs) {
    ensureBar();
    const box = state.barBox;
    box.remove_all_children();
    // Equal-width tabs: stretch to fill when few, shrink to MIN_TAB_W then the bar
    // scrolls when many. Reserve ~80px for the pinned + (and arrows on overflow).
    const barW = Math.round(Main.layoutManager.primaryMonitor.width * cfg.widthF());
    const tabW = Math.max(MIN_TAB_W, Math.floor((barW - 110) / Math.max(1, tabs.length)));
    let activeBtn = null;
    for (const t of tabs) {
        const b = tabButton(t, tabW);
        if (t.active)
            activeBtn = b;
        box.add_child(b);
    }
    // arrows + keeping the active tab on screen depend on layout; let it settle first
    addTimeout(50, () => {
        updateArrows();
        scrollToActive(activeBtn);
        return GLib.SOURCE_REMOVE;
    });
}

// Scroll the bar so the active tab is fully visible.
function scrollToActive(btn) {
    if (!btn || !state.barScroll)
        return;
    const a = state.barScroll.hadjustment;
    const x = btn.get_x();
    const w = btn.get_width();
    if (x < a.value)
        a.value = x;
    else if (x + w > a.value + a.page_size)
        a.value = x + w - a.page_size;
}

// Ask tmux for the window list and refresh the bar. Single tab -> no bar (borderless).
function updateBar(win) {
    win = win || findWindow();
    if (!cfg.useTmux() || !win || win.minimized) {
        if (state.barOn) { state.barOn = false; if (win) place(win); }
        hideBar();
        return;
    }
    listTabs(tabs => {
        const on = tabs.length > 1;
        const changed = on !== state.barOn;
        state.barOn = on;
        if (on) {
            renderTabs(tabs);
            const bar = ensureBar();
            bar.set_style(barStyle());            // apply live color/position changes
            bar.show();
        } else {
            hideBar();
        }
        const w = findWindow();
        if (w && (changed || on))
            place(w);   // re-reserve/release the strip and position the bar
    });
}

function listTabs(cb) {
    let proc;
    try {
        proc = Gio.Subprocess.new(
            ['tmux', '-L', TMUX_SOCKET, 'list-windows', '-t', cfg.session(),
             '-F', '#{window_index}\t#{window_name}\t#{window_active}'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (_e) {
        cb([]);
        return;
    }
    proc.communicate_utf8_async(null, null, (p, res) => {
        let out = '';
        try {
            [, out] = p.communicate_utf8_finish(res);
        } catch (_e) {
            cb([]);
            return;
        }
        const tabs = (out || '').trim().split('\n').filter(Boolean).map(line => {
            const [index, name, active] = line.split('\t');
            return {index, name: name || index, active: active === '1'};
        });
        cb(tabs);
    });
}

// --- Right-click context menu (custom St popup, kept hot) ----------------------
function showTabMenu(tab, x, y) {
    closeTabMenu();
    // click-catcher: a click anywhere outside the menu closes it
    const catcher = new St.Widget({reactive: true});
    catcher.set_size(global.stage.width, global.stage.height);
    catcher.connect('button-press-event', () => { closeTabMenu(); return Clutter.EVENT_STOP; });
    Main.layoutManager.addChrome(catcher, {affectsStruts: false});
    state.menuCatcher = catcher;
    const menu = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, reactive: true, style_class: 'quake-tab-menu'});
    menu.set_style(`background-color: ${cfg.barColor()}; border: 1px solid ${cfg.activeColor()}; border-radius: 4px; padding: 2px;`);
    const item = (label, fn) => {
        const b = new St.Button({label, x_expand: true, can_focus: false});
        withHover(b, `padding: 6px 18px; color: ${cfg.textColor()};`, 'background-color: rgba(255,255,255,0.1);');
        b.connect('clicked', () => { suppressHide(); closeTabMenu(); fn(); });
        b.connect('button-press-event', () => { suppressHide(); return Clutter.EVENT_PROPAGATE; });
        return b;
    };
    menu.add_child(item('New tab', () => newTab()));
    menu.add_child(item('Close', () => tmux(['kill-window', '-t', `${cfg.session()}:${tab.index}`])));
    menu.add_child(item('Close all but this', () => tmux(['kill-window', '-a', '-t', `${cfg.session()}:${tab.index}`])));
    menu.add_child(item('Close all to the right', () => closeSide(tab.index, +1)));
    menu.add_child(item('Close all to the left', () => closeSide(tab.index, -1)));
    Main.layoutManager.addChrome(menu, {affectsStruts: false});
    menu.set_position(Math.round(x), Math.round(y));
    state.menu = menu;
}

function closeTabMenu() {
    if (state.menuCatcher) {
        Main.layoutManager.removeChrome(state.menuCatcher);
        state.menuCatcher.destroy();
        state.menuCatcher = null;
    }
    if (state.menu) {
        Main.layoutManager.removeChrome(state.menu);
        state.menu.destroy();
        state.menu = null;
    }
}

// --- Spawn ---------------------------------------------------------------------
function spawn() {
    if (state.spawning)
        return;

    let argv;
    try {
        const [ok, parsed] = GLib.shell_parse_argv(cfg.command());
        if (!ok || !parsed || !parsed.length)
            throw new Error('empty command');
        argv = parsed;
    } catch (e) {
        Main.notifyError('Quake Style App', `bad command "${cfg.command()}": ${e.message}`);
        return;
    }

    // Tabs: run the app under tmux (tabs = tmux windows) and hide tmux's own status
    // bar — our native bar replaces it. The terminal runs its trailing argv.
    if (cfg.useTmux()) {
        writeTmuxExtra();
        const conf = GLib.build_filenamev([extPath, 'tmux.conf']);
        const tmuxArgv = ['tmux', '-L', TMUX_SOCKET, '-f', conf,
                          'new-session', '-A', '-s', cfg.session()];
        const name = randomName();
        if (name)
            tmuxArgv.push('-n', name);
        argv = argv.concat(tmuxArgv);
    }

    state.spawning = true;
    state.showing = true;

    const wm = global.window_manager;
    state.mapId = wm.connect('map', (_wm, actor) => {
        const w = actor.meta_window;
        if (!w || !isMine(w))
            return;
        wm.disconnect(state.mapId);
        state.mapId = 0;
        state.spawning = false;
        place(w);
        const laters = global.compositor?.get_laters?.();
        if (laters)
            laters.add(Meta.LaterType.BEFORE_REDRAW, () => { place(w); return false; });
        w.activate(global.display.get_current_time_roundtrip());
        watch(w);
        updateBar(w);
        clearShowing();
    });

    try {
        const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        const id = proc.get_identifier();
        state.spawnPid = id ? parseInt(id, 10) : 0;
    } catch (e) {
        state.spawning = false;
        state.showing = false;
        if (state.mapId) {
            wm.disconnect(state.mapId);
            state.mapId = 0;
        }
        Main.notifyError('Quake Style App', `launch failed: ${e.message}`);
    }
}

// --- Show / hide / toggle ------------------------------------------------------
function show() {
    ensureDesktop();
    const win = findWindow();
    if (!win) {
        spawn();
        return;
    }
    state.showing = true;
    try {
        if (win.minimized)
            win.unminimize();
        win.activate(global.display.get_current_time_roundtrip());
        place(win);
        watch(win);
        updateBar(win);
    } finally {
        clearShowing();
    }
}

function hide() {
    const win = findWindow();
    if (win && !win.minimized)
        win.minimize();
    hideBar();
    if (state.fill)
        state.fill.hide();
}

function toggle() {
    const win = findWindow();
    if (win && !win.minimized)
        hide();
    else
        show();
}

function onFocusChanged() {
    if (state.showing)
        return;
    const focus = global.display.focus_window;
    if (!focus)
        return;
    const win = findWindow();
    if (!win || win.minimized)
        return;
    if (focus !== win) {
        win.minimize();
        hideBar();
        if (state.fill)
            state.fill.hide();
    } else {
        // Re-focused via Alt+Tab / click (not our Show, which the state.showing guard
        // above lets through): the compositor restored the bare window, so re-assert
        // our chrome — placement, background fill (place) and the tab bar (updateBar).
        place(win);
        watch(win);
        updateBar(win);
    }
}

// --- Tabs (drive tmux) ---------------------------------------------------------
function tmux(args) {
    try {
        Gio.Subprocess.new(['tmux', '-L', TMUX_SOCKET, ...args], Gio.SubprocessFlags.NONE);
    } catch (e) {
        Main.notifyError('Quake Style App', `tmux failed: ${e.message}`);
    }
    // No manual refresh: tmux's hooks touch the tab-event file, our monitor sees the
    // change (setupTabMonitor) and repaints the bar.
}

// A short, evocative name for a new tab. Inlined so the shell never does file IO
// (no /usr/share/dict/words read): a small poetic word list, picked at random.
const TAB_WORDS = [
    'ember', 'zephyr', 'lumen', 'solace', 'willow', 'cinder', 'aurora', 'reverie',
    'halcyon', 'lantern', 'meadow', 'nimbus', 'saffron', 'twilight', 'velvet', 'whisper',
    'marigold', 'ripple', 'cobalt', 'dapple', 'hollow', 'lichen', 'mistral', 'nectar',
    'opaline', 'plume', 'quiver', 'radiant', 'seraph', 'tidal', 'umbra', 'verdant',
    'yarrow', 'azure', 'clover', 'elixir', 'fennel', 'glimmer', 'heron', 'indigo',
    'jasmine', 'kindle', 'laurel', 'bramble', 'thistle', 'juniper', 'crimson', 'gilded',
    'murmur', 'starlit',
];
function randomName() {
    return TAB_WORDS[Math.floor(Math.random() * TAB_WORDS.length)];
}

function newTab() {
    if (!cfg.useTmux() || !findWindow()) {
        show();                 // not running / no tmux -> first window is tab 1
        return;
    }
    const name = randomName();
    tmux(name ? ['new-window', '-t', cfg.session(), '-n', name]
              : ['new-window', '-t', cfg.session()]);
    show();
}
function closeTab() { if (cfg.useTmux()) tmux(['kill-window', '-t', cfg.session()]); }
function nextTab()  { if (cfg.useTmux()) tmux(['next-window', '-t', cfg.session()]); }
function prevTab()  { if (cfg.useTmux()) tmux(['previous-window', '-t', cfg.session()]); }
function refreshTabs() { updateBar(); }

// Close windows on one side of `index` (dir > 0 = right, dir < 0 = left).
function closeSide(index, dir) {
    const idx = parseInt(index, 10);
    listTabs(tabs => {
        for (const t of tabs) {
            const i = parseInt(t.index, 10);
            if (dir > 0 ? i > idx : i < idx)
                tmux(['kill-window', '-t', `${cfg.session()}:${t.index}`]);
        }
    });
}

// --- Keyboard shortcuts (internal — no media-keys, no D-Bus) -------------------
// Each action gets its own gschema "as" key, bound through the compositor. The user
// edits them in Preferences; we add/remove them in enable()/cleanup().
const KEYS = [
    ['toggle-hotkey',    () => toggle()],
    ['new-tab-hotkey',   () => newTab()],
    ['close-tab-hotkey', () => closeTab()],
    ['next-tab-hotkey',  () => nextTab()],
    ['prev-tab-hotkey',  () => prevTab()],
];
function addKeybindings() {
    for (const [key, handler] of KEYS) {
        Main.wm.addKeybinding(key, _settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, handler);
    }
}
function removeKeybindings() {
    for (const [key] of KEYS)
        Main.wm.removeKeybinding(key);
}

// --- Tab sync (replaces the old D-Bus RefreshTabs) -----------------------------
// tmux's hooks touch this file on every window change; we watch it and repaint. The
// only spawn is tmux's own `touch` in the hook — the extension does no IPC subprocess.
const TAB_EVENT_PATH = GLib.build_filenamev(
    [GLib.get_user_config_dir(), 'quake-style-app', '.tab-event']);
function setupTabMonitor() {
    try {
        const dir = GLib.build_filenamev([GLib.get_user_config_dir(), 'quake-style-app']);
        GLib.mkdir_with_parents(dir, 0o700);
        if (!GLib.file_test(TAB_EVENT_PATH, GLib.FileTest.EXISTS))
            GLib.file_set_contents(TAB_EVENT_PATH, '');
        state.tabMonitor = Gio.File.new_for_path(TAB_EVENT_PATH)
            .monitor_file(Gio.FileMonitorFlags.NONE, null);
        state.tabMonitorId = state.tabMonitor.connect('changed', () => {
            // Coalesce the burst of hooks tmux fires for one user action into one repaint.
            if (state.tabRefreshQueued)
                return;
            state.tabRefreshQueued = true;
            addTimeout(60, () => {
                state.tabRefreshQueued = false;
                refreshTabs();
                return GLib.SOURCE_REMOVE;
            });
        });
    } catch (_e) {
        // Tabs still refresh on our own actions and on show/focus; only in-terminal
        // tmux changes would be missed without the monitor.
    }
}

// --- Lifecycle -----------------------------------------------------------------
export function enable(ext) {
    _settings = ext.getSettings();
    extPath = ext.path;
    state = {timers: new Set()};
    addKeybindings();
    state.focusId = global.display.connect('notify::focus-window', onFocusChanged);
    setupTabMonitor();
}

export function disable() {
    cleanup();
    _settings = null;
}

function cleanup() {
    removeKeybindings();
    if (state.focusId) {
        global.display.disconnect(state.focusId);
        state.focusId = 0;
    }
    if (state.tabMonitor) {
        if (state.tabMonitorId)
            state.tabMonitor.disconnect(state.tabMonitorId);
        state.tabMonitor.cancel();
        state.tabMonitor = null;
        state.tabMonitorId = 0;
    }
    unwatch();
    destroyFill();
    destroyBar();
    if (state.mapId) {
        global.window_manager.disconnect(state.mapId);
        state.mapId = 0;
    }
    if (state.timers) {
        for (const id of state.timers)
            GLib.Source.remove(id);
        state.timers.clear();
    }
    // On a REAL disable (not a screen lock, where extensions are also disabled) kill the
    // private tmux server so no orphaned tmux/foot processes linger.
    if (cfg.useTmux() && Main.sessionMode.currentMode !== 'unlock-dialog')
        tmux(['kill-server']);
}
