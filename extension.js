import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const UPDATE_INTERVAL_MS = 1000;

function formatRate(bytesPerSecond) {
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];

    let value = bytesPerSecond;
    let unitIndex = 0;

    while (value >= 1000 && unitIndex < units.length - 1) {
        value /= 1000;
        unitIndex++;
    }

    let precision;

    if (value >= 100) {
        precision = 0;
    } else if (value >= 10) {
        precision = 1;
    } else {
        precision = 2;
    }

    return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export default class NetTrackExtension extends Extension {
    enable() {
        // Load extension stylesheet.
        this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        this._stylesheet = this.dir.get_child('stylesheet.css');
        this._theme.load_stylesheet(this._stylesheet);

        // Create panel indicator.
        this._indicator = new PanelMenu.Button(
            0.0,
            this.metadata.name,
            false
        );

        this._label = new St.Label({
            text: '↓ --   ↑ --',
            style_class: 'nettrack-label',
        });

        this._indicator.add_child(this._label);

        Main.panel.addToStatusArea(
            this.uuid,
            this._indicator
        );

        // Initialize throughput state.
        this._interface = null;
        this._previousRxBytes = null;
        this._previousTxBytes = null;
        this._previousTime = null;

        // Get the first sample immediately.
        this._updateNetworkStats();

        // Update every second.
        this._timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            UPDATE_INTERVAL_MS,
            () => {
                this._updateNetworkStats();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    disable() {
        // Remove update timer.
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        // Remove panel indicator.
        this._indicator?.destroy();
        this._indicator = null;
        this._label = null;

        // Reset throughput state.
        this._interface = null;
        this._previousRxBytes = null;
        this._previousTxBytes = null;
        this._previousTime = null;

        // Unload extension stylesheet.
        if (this._theme && this._stylesheet) {
            this._theme.unload_stylesheet(this._stylesheet);
        }

        this._theme = null;
        this._stylesheet = null;
    }

    _getInterface() {
        try {
            // This is a synchronous I/O call, but /proc/net/route is a small
            // virtual file and reading it is very fast.
            const [ok, contents] = GLib.file_get_contents('/proc/net/route');
            if (!ok) {
                // This can happen if the proc file is not available for some reason.
                return null;
            }

            const routes = new TextDecoder().decode(contents).trim().split('\n');

            // Skip header line and find the default route.
            for (let i = 1; i < routes.length; i++) {
                const fields = routes[i].split(/\s+/);
                const [iface, destination] = fields;

                // The default route has a destination of 00000000.
                if (destination === '00000000') {
                    return iface;
                }
            }
        } catch (e) {
            console.error(`NetTrack: Error getting default interface: ${e.message}`);
        }

        return null; // No default route found.
    }

    _updateNetworkStats() {
        const currentInterface = this._getInterface();

        if (currentInterface !== this._interface) {
            // Interface has changed (or is being detected for the first time).
            // Reset stats to avoid calculating rates based on old data from a different interface.
            this._previousRxBytes = null;
            this._previousTxBytes = null;
            this._previousTime = null;
            this._interface = currentInterface;
        }

        if (!this._interface) {
            // No active interface found, display placeholder.
            this._label.set_text('↓ --   ↑ --');
            return;
        }

        this._readCounter(this._interface, 'rx_bytes', rxBytes => {
            if (rxBytes === null) return; // Error was logged in _readCounter

            this._readCounter(this._interface, 'tx_bytes', txBytes => {
                if (txBytes === null) return; // Error was logged in _readCounter

                const now = GLib.get_monotonic_time();

                if (
                    this._previousRxBytes !== null &&
                    this._previousTxBytes !== null &&
                    this._previousTime !== null &&
                    // Ensure byte counters are not smaller than previous, which can
                    // happen on interface reset or other system events.
                    rxBytes >= this._previousRxBytes &&
                    txBytes >= this._previousTxBytes
                ) {
                    const elapsedSeconds =
                        (now - this._previousTime) / 1_000_000;

                    if (elapsedSeconds > 0) {
                        const rxRate = (rxBytes - this._previousRxBytes) / elapsedSeconds;
                        const txRate = (txBytes - this._previousTxBytes) / elapsedSeconds;

                        this._label.set_text(`↓ ${formatRate(rxRate)}   ↑ ${formatRate(txRate)}`);
                    }
                }

                this._previousRxBytes = rxBytes;
                this._previousTxBytes = txBytes;
                this._previousTime = now;
            });
        });
    }

    _readCounter(interfaceName, counter, callback) {
        const path = `/sys/class/net/${interfaceName}/statistics/${counter}`;

        const file = Gio.File.new_for_path(path);

        file.load_contents_async(null, (source, result) => {
            try {
                const [success, contents] = source.load_contents_finish(result);

                if (!success) {
                    // This can happen if the interface goes down. Log as a warning.
                    console.warn(`NetTrack: Failed to read ${path}`);
                    callback(null);
                    return;
                }

                const text =
                    new TextDecoder().decode(contents).trim();

                const value = Number.parseInt(text, 10);

                if (!Number.isFinite(value)) {
                    throw new Error(`Invalid counter value: ${text}`);
                }

                callback(value);
            } catch (error) {
                console.error(`NetTrack: ${error.message}`);
                callback(null);
            }
        });
    }
}