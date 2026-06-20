// Quake Style App — extension entry point.
//
// All behaviour lives in ./logic.js (a normal ES module, bundled and reviewed with
// the extension). This file just wires GNOME's enable()/disable() to it. Hotkeys are
// internal (Main.wm.addKeybinding over our own gschema keys), so there is no D-Bus
// surface and nothing external to bind.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Logic from './logic.js';

export default class QuakeStyleAppExtension extends Extension {
    enable() {
        Logic.enable(this);
    }

    disable() {
        Logic.disable();
    }
}
