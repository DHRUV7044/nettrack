import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const INTERFACE = 'wlp109s0f0';
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
        this._indicator = new PanelMenu.Button(
            0.0,
            this.metadata.name,
            false
        );

        this._label = new St.Label({
            text: '↓ --   ↑ --',
        });

        this._indicator.add_child(this._label);

        Main.panel.addToStatusArea(
            this.uuid,
            this._indicator
        );

        this._previousRxBytes = null;
        this._previousTxBytes = null;
        this._previousTime = null;

        this._updateNetworkStats();

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
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        this._indicator?.destroy();
        this._indicator = null;
        this._label = null;

        this._previousRxBytes = null;
        this._previousTxBytes = null;
        this._previousTime = null;
    }

    _updateNetworkStats() {
        this._readCounter('rx_bytes', rxBytes => {
            this._readCounter('tx_bytes', txBytes => {
                const now = GLib.get_monotonic_time();

                if (
                    this._previousRxBytes !== null &&
                    this._previousTxBytes !== null &&
                    this._previousTime !== null
                ) {
                    const elapsedSeconds =
                        (now - this._previousTime) / 1_000_000;

                    const rxRate =
                        (rxBytes - this._previousRxBytes) /
                        elapsedSeconds;

                    const txRate =
                        (txBytes - this._previousTxBytes) /
                        elapsedSeconds;

                    const rxText = formatRate(rxRate);
                    const txText = formatRate(txRate);

                    this._label.set_text(
                        `↓ ${rxText}   ↑ ${txText}`
                    );
                }

                this._previousRxBytes = rxBytes;
                this._previousTxBytes = txBytes;
                this._previousTime = now;
            });
        });
    }

    _readCounter(counter, callback) {
        const path = `/sys/class/net/${INTERFACE}/statistics/${counter}`;
        const file = Gio.File.new_for_path(path);

        file.load_contents_async(null, (source, result) => {
            try {
                const [success, contents] =
                    source.load_contents_finish(result);

                if (!success) {
                    throw new Error(`Failed to read ${path}`);
                }

                const text =
                    new TextDecoder().decode(contents).trim();

                const value = Number.parseInt(text, 10);

                if (!Number.isFinite(value)) {
                    throw new Error(
                        `Invalid counter value: ${text}`
                    );
                }

                callback(value);
            } catch (error) {
                console.error(`NetTrack: ${error.message}`);
            }
        });
    }
}