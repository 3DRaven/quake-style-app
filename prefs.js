// Quake Style App — Preferences UI. Shown in the GNOME Extensions app and via
//   gnome-extensions prefs quake-style-app@i3draven.github.io
// Every option here is the same GSettings the running extension reads, and the
// shortcuts are the same GNOME "custom keybindings" as Settings -> Keyboard.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// The actions that can be bound to a key, with their gschema "as" keys. These are the
// extension's OWN keybindings (Main.wm.addKeybinding) — no system shortcuts touched.
const SHORTCUTS = [
    ['toggle-hotkey',    'Toggle dropdown'],
    ['new-tab-hotkey',   'New tab'],
    ['next-tab-hotkey',  'Next tab'],
    ['prev-tab-hotkey',  'Previous tab'],
    ['close-tab-hotkey', 'Close tab'],
];

// Render a stored accelerator (e.g. "<Control>F10") the way a user reads it ("Ctrl+F10").
function accelLabel(accel) {
    const [ok, keyval, mods] = Gtk.accelerator_parse(accel);
    return ok ? Gtk.accelerator_get_label(keyval, mods) : accel;
}

function hexToRgba(hex) {
    const c = new Gdk.RGBA();
    c.parse(hex || '#000000');
    return c;
}
function rgbaToHex(c) {
    const h = n => Math.round(n * 255).toString(16).padStart(2, '0');
    return `#${h(c.red)}${h(c.green)}${h(c.blue)}`;
}

// Read "Icon=" from <desktopId> in the XDG application dirs via GLib.KeyFile (mirrors
// logic.js desktopIcon — no DesktopAppInfo, works on every GLib version).
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

// The icon the empty-setting default would resolve to (the launched app's own icon),
// used for the preview when no explicit icon is chosen. Mirrors logic.js nativeIcon().
function nativeIconHint(settings) {
    const bin = (settings.get_string('command') || '').trim().split(/\s+/)[0].split('/').pop();
    return (bin && desktopIcon(`${bin}.desktop`)) || 'application-x-executable';
}

// A grid picker over every icon name the current theme knows, with live search.
// GridView recycles its cell widgets, so the full (thousands-strong) set is cheap.
function openIconPicker(parent, settings) {
    const dialog = new Adw.Dialog({
        title: 'Choose an icon', content_width: 600, content_height: 540,
    });
    const view = new Adw.ToolbarView();
    view.add_top_bar(new Adw.HeaderBar());

    const outer = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
    const search = new Gtk.SearchEntry({
        placeholder_text: 'Search icons…', hexpand: true,
        margin_start: 12, margin_end: 12, margin_top: 12,
    });
    outer.append(search);

    const names = Gtk.IconTheme.get_for_display(parent.get_display()).get_icon_names();
    names.sort();
    const store = new Gtk.StringList();
    for (const n of names)
        store.append(n);

    const filter = new Gtk.StringFilter({
        expression: Gtk.PropertyExpression.new(Gtk.StringObject, null, 'string'),
        ignore_case: true, match_mode: Gtk.StringFilterMatchMode.SUBSTRING,
    });
    const selection = new Gtk.SingleSelection({
        model: new Gtk.FilterListModel({model: store, filter}),
        autoselect: false, can_unselect: true,
    });

    const factory = new Gtk.SignalListItemFactory();
    factory.connect('setup', (_f, li) => {
        const cell = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 4,
            margin_top: 8, margin_bottom: 8, width_request: 84,
        });
        cell.append(new Gtk.Image({pixel_size: 44}));
        cell.append(new Gtk.Label({
            ellipsize: Pango.EllipsizeMode.END, max_width_chars: 11, css_classes: ['caption'],
        }));
        li.set_child(cell);
    });
    factory.connect('bind', (_f, li) => {
        const name = li.get_item().get_string();
        const cell = li.get_child();
        cell.get_first_child().icon_name = name;
        cell.get_last_child().label = name;
        cell.tooltip_text = name;
    });

    const grid = new Gtk.GridView({
        model: selection, factory, max_columns: 10, min_columns: 3,
        vexpand: true, single_click_activate: true,
    });
    outer.append(new Gtk.ScrolledWindow({child: grid, vexpand: true}));

    search.connect('search-changed', () => filter.set_search(search.get_text()));
    grid.connect('activate', (_g, pos) => {
        const obj = selection.get_model().get_item(pos);
        if (obj)
            settings.set_string('icon', obj.get_string());
        dialog.close();
    });

    view.set_content(outer);
    dialog.set_child(view);
    dialog.present(parent);
}

export default class QuakeStyleAppPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        // --- Launch ---------------------------------------------------------
        const launch = new Adw.PreferencesGroup({
            title: 'Launch',
            description: 'Any application can be the dropdown — not only foot.',
        });
        page.add(launch);
        const command = new Adw.EntryRow({title: 'Command'});
        settings.bind('command', command, 'text', Gio.SettingsBindFlags.DEFAULT);
        launch.add(command);
        const appId = new Adw.EntryRow({title: 'Window app-id / class to match'});
        settings.bind('app-id', appId, 'text', Gio.SettingsBindFlags.DEFAULT);
        launch.add(appId);
        const iconRow = new Adw.ActionRow({title: 'Window icon'});
        const iconImg = new Gtk.Image({pixel_size: 32, valign: Gtk.Align.CENTER});
        const chooseBtn = new Gtk.Button({label: 'Choose…', valign: Gtk.Align.CENTER});
        const resetBtn = new Gtk.Button({
            icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Use the launched app’s own icon', css_classes: ['flat'],
        });
        const refreshIcon = () => {
            const v = settings.get_string('icon');
            iconRow.subtitle = v ? v : `The app’s own icon (${nativeIconHint(settings)})`;
            iconImg.icon_name = v || nativeIconHint(settings);
        };
        refreshIcon();
        settings.connect('changed::icon', refreshIcon);
        settings.connect('changed::command', refreshIcon);
        chooseBtn.connect('clicked', () => openIconPicker(window, settings));
        resetBtn.connect('clicked', () => settings.set_string('icon', ''));
        iconRow.add_suffix(iconImg);
        iconRow.add_suffix(chooseBtn);
        iconRow.add_suffix(resetBtn);
        iconRow.activatable_widget = chooseBtn;
        launch.add(iconRow);

        // --- Geometry -------------------------------------------------------
        const geom = new Adw.PreferencesGroup({
            title: 'Geometry',
            description: 'Size is a fraction of the monitor; width is centered.',
        });
        page.add(geom);
        const heightAdj = new Gtk.Adjustment({lower: 0.1, upper: 1.0, step_increment: 0.05, page_increment: 0.1});
        const height = new Adw.SpinRow({title: 'Height fraction', adjustment: heightAdj, digits: 2});
        settings.bind('height-fraction', heightAdj, 'value', Gio.SettingsBindFlags.DEFAULT);
        geom.add(height);
        const widthAdj = new Gtk.Adjustment({lower: 0.1, upper: 1.0, step_increment: 0.05, page_increment: 0.1});
        const width = new Adw.SpinRow({title: 'Width fraction', adjustment: widthAdj, digits: 2});
        settings.bind('width-fraction', widthAdj, 'value', Gio.SettingsBindFlags.DEFAULT);
        geom.add(width);
        const positions = ['top', 'bottom'];
        const position = new Adw.ComboRow({title: 'Position', model: new Gtk.StringList({strings: positions})});
        position.selected = Math.max(0, positions.indexOf(settings.get_string('position')));
        position.connect('notify::selected', () => settings.set_string('position', positions[position.selected] ?? 'top'));
        settings.connect('changed::position', () => {
            const i = positions.indexOf(settings.get_string('position'));
            if (i >= 0 && i !== position.selected)
                position.selected = i;
        });
        geom.add(position);

        // --- Tabs (tmux) ----------------------------------------------------
        const tabs = new Adw.PreferencesGroup({
            title: 'Tabs (tmux)',
            description: 'Run the app under an isolated tmux to get tabs; the native bar replaces tmux’s own.',
        });
        page.add(tabs);
        const useTmux = new Adw.SwitchRow({title: 'Run under tmux (enable tabs)'});
        settings.bind('use-tmux', useTmux, 'active', Gio.SettingsBindFlags.DEFAULT);
        tabs.add(useTmux);
        const session = new Adw.EntryRow({title: 'tmux session name'});
        settings.bind('tmux-session', session, 'text', Gio.SettingsBindFlags.DEFAULT);
        tabs.add(session);
        const closeModes = ['kill', 'detach'];
        const onClose = new Adw.ComboRow({
            title: 'On window close (Alt+F4)',
            model: new Gtk.StringList({strings: ['Kill the session', 'Detach (keep running)']}),
        });
        onClose.selected = Math.max(0, closeModes.indexOf(settings.get_string('on-window-close')));
        onClose.connect('notify::selected', () => settings.set_string('on-window-close', closeModes[onClose.selected] ?? 'kill'));
        settings.connect('changed::on-window-close', () => {
            const i = closeModes.indexOf(settings.get_string('on-window-close'));
            if (i >= 0 && i !== onClose.selected)
                onClose.selected = i;
        });
        tabs.add(onClose);

        // --- Tab bar look ---------------------------------------------------
        const look = new Adw.PreferencesGroup({title: 'Tab bar'});
        page.add(look);
        const sides = ['top', 'bottom'];
        const barPos = new Adw.ComboRow({
            title: 'Bar side', subtitle: 'Above or below the terminal',
            model: new Gtk.StringList({strings: ['Above terminal', 'Below terminal']}),
        });
        barPos.selected = Math.max(0, sides.indexOf(settings.get_string('bar-position')));
        barPos.connect('notify::selected', () => settings.set_string('bar-position', sides[barPos.selected] ?? 'top'));
        settings.connect('changed::bar-position', () => {
            const i = sides.indexOf(settings.get_string('bar-position'));
            if (i >= 0 && i !== barPos.selected)
                barPos.selected = i;
        });
        look.add(barPos);
        const bhAdj = new Gtk.Adjustment({lower: 20, upper: 160, step_increment: 2, page_increment: 10});
        bhAdj.set_value(settings.get_int('bar-height'));
        const bh = new Adw.SpinRow({title: 'Bar height (px)', adjustment: bhAdj});
        bhAdj.connect('value-changed', () => settings.set_int('bar-height', Math.round(bhAdj.value)));
        settings.connect('changed::bar-height', () => bhAdj.set_value(settings.get_int('bar-height')));
        look.add(bh);

        // --- Colors (all in one place) --------------------------------------
        const colors = new Adw.PreferencesGroup({title: 'Colors'});
        page.add(colors);
        const fillBg = new Adw.SwitchRow({
            title: 'Background behind terminal',
            subtitle: 'Fill behind the window so no gap shows the desktop',
        });
        settings.bind('fill-background', fillBg, 'active', Gio.SettingsBindFlags.DEFAULT);
        colors.add(fillBg);
        for (const [key, title] of [
            ['bar-color', 'Tab bar background'],
            ['active-color', 'Active tab'],
            ['text-color', 'Tab text'],
            ['fill-color', 'Background fill'],
        ]) {
            const row = new Adw.ActionRow({title});
            const cb = new Gtk.ColorDialogButton({valign: Gtk.Align.CENTER, dialog: new Gtk.ColorDialog()});
            cb.set_rgba(hexToRgba(settings.get_string(key)));
            cb.connect('notify::rgba', () => settings.set_string(key, rgbaToHex(cb.get_rgba())));
            row.add_suffix(cb);
            colors.add(row);
        }

        // --- Extra tmux config (isolated) -----------------------------------
        const tcfg = new Adw.PreferencesGroup({
            title: 'Extra tmux config',
            description: 'Applied only to the dropdown’s private tmux (host ~/.tmux.conf is never loaded). One command per line, e.g. "set -g mouse on".',
        });
        page.add(tcfg);
        const tv = new Gtk.TextView({
            monospace: true, top_margin: 6, bottom_margin: 6, left_margin: 8, right_margin: 8,
        });
        tv.buffer.text = settings.get_string('tmux-config');
        tv.buffer.connect('changed', () => settings.set_string('tmux-config', tv.buffer.text));
        const tsw = new Gtk.ScrolledWindow({child: tv, vexpand: false, height_request: 100});
        tsw.add_css_class('card');
        tcfg.add(tsw);

        // --- Keyboard shortcuts (the extension's own, internal bindings) ----
        const sc = new Adw.PreferencesGroup({
            title: 'Keyboard shortcuts',
            description: 'Bound inside the extension — no system shortcuts are touched.',
        });
        page.add(sc);
        for (const [key, label] of SHORTCUTS) {
            const row = new Adw.ActionRow({title: label});
            const setBtn = new Gtk.Button({valign: Gtk.Align.CENTER});
            const refresh = () => {
                const accel = settings.get_strv(key)[0] || '';
                setBtn.label = accel ? accelLabel(accel) : 'Disabled';
            };
            refresh();
            settings.connect(`changed::${key}`, refresh);
            setBtn.connect('clicked', () => this._capture(window, accel => settings.set_strv(key, [accel])));
            row.add_suffix(setBtn);
            const clr = new Gtk.Button({icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Clear shortcut'});
            clr.add_css_class('flat');
            clr.connect('clicked', () => settings.set_strv(key, []));
            row.add_suffix(clr);
            row.activatable_widget = setBtn;
            sc.add(row);
        }
    }

    // Modal that captures the next shortcut and reports it as a gsettings accelerator.
    _capture(parent, onAccel) {
        const dialog = new Adw.Dialog({
            title: 'Set shortcut', content_width: 380, content_height: 150,
        });
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, spacing: 12,
            margin_top: 24, margin_bottom: 24, margin_start: 24, margin_end: 24,
        });
        box.append(new Gtk.Label({label: 'Press the new shortcut, or Esc to cancel.', wrap: true}));
        dialog.set_child(box);
        const ctl = new Gtk.EventControllerKey();
        ctl.connect('key-pressed', (_c, keyval, _code, state) => {
            if (keyval === Gdk.KEY_Escape) {
                dialog.close();
                return true;
            }
            const MODS = [
                Gdk.KEY_Control_L, Gdk.KEY_Control_R, Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
                Gdk.KEY_Alt_L, Gdk.KEY_Alt_R, Gdk.KEY_Super_L, Gdk.KEY_Super_R,
                Gdk.KEY_Meta_L, Gdk.KEY_Meta_R, Gdk.KEY_ISO_Level3_Shift,
            ];
            if (MODS.includes(keyval))
                return true;
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            const accel = Gtk.accelerator_name(keyval, mods);
            if (accel)
                onAccel(accel);
            dialog.close();
            return true;
        });
        dialog.add_controller(ctl);
        dialog.present(parent);
    }
}
