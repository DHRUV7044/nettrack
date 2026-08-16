import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const UPDATE_INTERVAL_MS = 1000;
const HIDDEN_INTERFACE_PREFIXES = [
    'br-',
    'docker',
    'veth',
    'virbr',
    'vmnet',
];
const HIDDEN_BLOCK_DEVICE_PREFIXES = [
    'dm-',
    'loop',
    'ram',
    'zram',
];
const DISK_SECTOR_SIZE_BYTES = 512;

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

        this._networkSection = new PopupMenu.PopupMenuSection();
        this._diskSection = new PopupMenu.PopupMenuSection();
        this._networkTotalItem = this._createInfoMenuItem('Network total  ↓ --   ↑ --');
        this._networkEmptyItem = this._createInfoMenuItem('No network interfaces found');
        this._networkItems = new Map();
        this._diskTotalItem = this._createInfoMenuItem('Disk total  Read --   Write --');
        this._diskEmptyItem = this._createInfoMenuItem('No disks found');
        this._diskItems = new Map();

        this._indicator.menu.addMenuItem(this._networkSection);
        this._networkSection.addMenuItem(this._networkTotalItem);
        this._networkSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._networkSection.addMenuItem(this._networkEmptyItem);

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._indicator.menu.addMenuItem(this._diskSection);
        this._diskSection.addMenuItem(this._diskTotalItem);
        this._diskSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._diskSection.addMenuItem(this._diskEmptyItem);

        Main.panel.addToStatusArea(
            this.uuid,
            this._indicator
        );

        // Initialize throughput state.
        this._previousNetworkStats = new Map();
        this._previousDiskStats = new Map();

        // Get the first sample immediately.
        this._updateStats();

        // Update every second.
        this._timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            UPDATE_INTERVAL_MS,
            () => {
                this._updateStats();
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
        this._networkSection = null;
        this._diskSection = null;
        this._networkTotalItem = null;
        this._networkEmptyItem = null;
        this._networkItems = null;
        this._diskTotalItem = null;
        this._diskEmptyItem = null;
        this._diskItems = null;

        // Reset throughput state.
        this._previousNetworkStats = null;
        this._previousDiskStats = null;

        // Unload extension stylesheet.
        if (this._theme && this._stylesheet) {
            this._theme.unload_stylesheet(this._stylesheet);
        }

        this._theme = null;
        this._stylesheet = null;
    }

    _createInfoMenuItem(text) {
        return new PopupMenu.PopupMenuItem(text, {
            reactive: false,
            can_focus: false,
        });
    }

    _getDefaultInterface() {
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

    _getNetworkInterfaces() {
        const interfaces = [];
        let enumerator = null;

        try {
            const directory = Gio.File.new_for_path('/sys/class/net');

            enumerator = directory.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let fileInfo;
            while ((fileInfo = enumerator.next_file(null)) !== null) {
                const interfaceName = fileInfo.get_name();

                if (this._shouldShowInterface(interfaceName)) {
                    interfaces.push(interfaceName);
                }
            }
        } catch (error) {
            console.error(`NetTrack: Error reading network interfaces: ${error.message}`);
        } finally {
            if (enumerator !== null) {
                try {
                    enumerator.close(null);
                } catch (error) {
                    console.error(`NetTrack: Error closing interface list: ${error.message}`);
                }
            }
        }

        return interfaces.sort((a, b) => a.localeCompare(b));
    }

    _shouldShowInterface(interfaceName) {
        if (interfaceName === 'lo') {
            return false;
        }

        return !HIDDEN_INTERFACE_PREFIXES.some(prefix =>
            interfaceName.startsWith(prefix)
        );
    }

    _updateStats() {
        this._updateNetworkStats();
        this._updateDiskStats();
    }

    _updateNetworkStats() {
        const now = GLib.get_monotonic_time();
        const defaultInterface = this._getDefaultInterface();
        const interfaces = this._getNetworkInterfaces();
        const currentInterfaces = new Set();
        const rows = [];
        let totalRxRate = 0;
        let totalTxRate = 0;
        let hasRate = false;

        for (const interfaceName of interfaces) {
            const rxBytes = this._readNetworkCounter(interfaceName, 'rx_bytes');
            const txBytes = this._readNetworkCounter(interfaceName, 'tx_bytes');

            if (rxBytes === null || txBytes === null) {
                continue;
            }

            currentInterfaces.add(interfaceName);

            const previous = this._previousNetworkStats.get(interfaceName);
            let rxRate = null;
            let txRate = null;

            if (
                previous &&
                rxBytes >= previous.rxBytes &&
                txBytes >= previous.txBytes
            ) {
                const elapsedSeconds = (now - previous.time) / 1_000_000;

                if (elapsedSeconds > 0) {
                    rxRate = (rxBytes - previous.rxBytes) / elapsedSeconds;
                    txRate = (txBytes - previous.txBytes) / elapsedSeconds;
                    totalRxRate += rxRate;
                    totalTxRate += txRate;
                    hasRate = true;
                }
            }

            this._previousNetworkStats.set(interfaceName, {
                rxBytes,
                txBytes,
                time: now,
            });

            rows.push({
                interfaceName,
                rxRate,
                txRate,
                isDefault: interfaceName === defaultInterface,
                label: this._getConnectionLabel(interfaceName),
            });
        }

        for (const interfaceName of this._previousNetworkStats.keys()) {
            if (!currentInterfaces.has(interfaceName)) {
                this._previousNetworkStats.delete(interfaceName);
            }
        }

        this._setRateLabels(totalRxRate, totalTxRate, hasRate);
        this._syncMenuRows(rows);
    }

    _setRateLabels(rxRate, txRate, hasRate) {
        const rateText = hasRate
            ? `↓ ${formatRate(rxRate)}   ↑ ${formatRate(txRate)}`
            : '↓ --   ↑ --';

        this._label.set_text(rateText);
        this._networkTotalItem.label.set_text(`Network total  ${rateText}`);
    }

    _syncMenuRows(rows) {
        const visibleInterfaces = new Set(rows.map(row => row.interfaceName));

        this._networkEmptyItem.visible = rows.length === 0;

        for (const [interfaceName, item] of this._networkItems.entries()) {
            if (!visibleInterfaces.has(interfaceName)) {
                item.destroy();
                this._networkItems.delete(interfaceName);
            }
        }

        rows.sort((a, b) => {
            if (a.isDefault !== b.isDefault) {
                return a.isDefault ? -1 : 1;
            }

            return a.interfaceName.localeCompare(b.interfaceName);
        });

        for (const row of rows) {
            let item = this._networkItems.get(row.interfaceName);

            if (!item) {
                item = this._createInfoMenuItem('');
                this._networkItems.set(row.interfaceName, item);
                this._networkSection.addMenuItem(item);
            }

            item.label.set_text(this._formatInterfaceRow(row));
        }
    }

    _formatInterfaceRow(row) {
        const rxText = row.rxRate === null ? '--' : formatRate(row.rxRate);
        const txText = row.txRate === null ? '--' : formatRate(row.txRate);
        const defaultText = row.isDefault ? ', default' : '';

        return `${row.label} (${row.interfaceName}${defaultText})  ↓ ${rxText}   ↑ ${txText}`;
    }

    _getConnectionLabel(interfaceName) {
        const name = interfaceName.toLowerCase();

        if (
            GLib.file_test(
                `/sys/class/net/${interfaceName}/wireless`,
                GLib.FileTest.IS_DIR
            ) ||
            name.startsWith('wl')
        ) {
            return 'Wi-Fi';
        }

        if (
            name.startsWith('tun') ||
            name.startsWith('tap') ||
            name.startsWith('wg') ||
            name.startsWith('vpn') ||
            name.startsWith('tailscale') ||
            name.startsWith('zt')
        ) {
            return 'VPN';
        }

        if (
            name.startsWith('ww') ||
            name.startsWith('ppp') ||
            name.includes('wwan')
        ) {
            return 'Mobile';
        }

        const deviceLink = this._readDeviceLink(interfaceName);
        const deviceModalias = this._readTextFile(
            `/sys/class/net/${interfaceName}/device/modalias`
        ) ?? '';

        if (
            name.startsWith('usb') ||
            name.startsWith('enx') ||
            deviceLink.includes('usb') ||
            deviceModalias.startsWith('usb:')
        ) {
            return 'USB-C/LAN';
        }

        if (
            name.startsWith('en') ||
            name.startsWith('eth')
        ) {
            return 'LAN';
        }

        return 'Other';
    }

    _readDeviceLink(interfaceName) {
        try {
            return GLib.file_read_link(
                `/sys/class/net/${interfaceName}/device`
            ).toLowerCase();
        } catch (error) {
            return '';
        }
    }

    _updateDiskStats() {
        const now = GLib.get_monotonic_time();
        const devices = this._getBlockDevices();
        const currentDevices = new Set();
        const rows = [];
        let totalReadRate = 0;
        let totalWriteRate = 0;
        let hasRate = false;

        for (const deviceName of devices) {
            const counters = this._readDiskCounters(deviceName);

            if (counters === null) {
                continue;
            }

            currentDevices.add(deviceName);

            const previous = this._previousDiskStats.get(deviceName);
            let readRate = null;
            let writeRate = null;

            if (
                previous &&
                counters.readBytes >= previous.readBytes &&
                counters.writeBytes >= previous.writeBytes
            ) {
                const elapsedSeconds = (now - previous.time) / 1_000_000;

                if (elapsedSeconds > 0) {
                    readRate =
                        (counters.readBytes - previous.readBytes) / elapsedSeconds;
                    writeRate =
                        (counters.writeBytes - previous.writeBytes) / elapsedSeconds;
                    totalReadRate += readRate;
                    totalWriteRate += writeRate;
                    hasRate = true;
                }
            }

            this._previousDiskStats.set(deviceName, {
                readBytes: counters.readBytes,
                writeBytes: counters.writeBytes,
                time: now,
            });

            rows.push({
                deviceName,
                label: this._getDiskLabel(deviceName),
                readRate,
                writeRate,
            });
        }

        for (const deviceName of this._previousDiskStats.keys()) {
            if (!currentDevices.has(deviceName)) {
                this._previousDiskStats.delete(deviceName);
            }
        }

        this._setDiskRateLabels(totalReadRate, totalWriteRate, hasRate);
        this._syncDiskRows(rows);
    }

    _getBlockDevices() {
        const devices = [];
        let enumerator = null;

        try {
            const directory = Gio.File.new_for_path('/sys/block');

            enumerator = directory.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let fileInfo;
            while ((fileInfo = enumerator.next_file(null)) !== null) {
                const deviceName = fileInfo.get_name();

                if (this._shouldShowBlockDevice(deviceName)) {
                    devices.push(deviceName);
                }
            }
        } catch (error) {
            console.error(`NetTrack: Error reading block devices: ${error.message}`);
        } finally {
            if (enumerator !== null) {
                try {
                    enumerator.close(null);
                } catch (error) {
                    console.error(`NetTrack: Error closing block device list: ${error.message}`);
                }
            }
        }

        return devices.sort((a, b) => a.localeCompare(b));
    }

    _shouldShowBlockDevice(deviceName) {
        return !HIDDEN_BLOCK_DEVICE_PREFIXES.some(prefix =>
            deviceName.startsWith(prefix)
        );
    }

    _setDiskRateLabels(readRate, writeRate, hasRate) {
        const rateText = hasRate
            ? `Read ${formatRate(readRate)}   Write ${formatRate(writeRate)}`
            : 'Read --   Write --';

        this._diskTotalItem.label.set_text(`Disk total  ${rateText}`);
    }

    _syncDiskRows(rows) {
        const visibleDevices = new Set(rows.map(row => row.deviceName));

        this._diskEmptyItem.visible = rows.length === 0;

        for (const [deviceName, item] of this._diskItems.entries()) {
            if (!visibleDevices.has(deviceName)) {
                item.destroy();
                this._diskItems.delete(deviceName);
            }
        }

        rows.sort((a, b) => a.deviceName.localeCompare(b.deviceName));

        for (const row of rows) {
            let item = this._diskItems.get(row.deviceName);

            if (!item) {
                item = this._createInfoMenuItem('');
                this._diskItems.set(row.deviceName, item);
                this._diskSection.addMenuItem(item);
            }

            item.label.set_text(this._formatDiskRow(row));
        }
    }

    _formatDiskRow(row) {
        const readText = row.readRate === null ? '--' : formatRate(row.readRate);
        const writeText = row.writeRate === null ? '--' : formatRate(row.writeRate);

        return `${row.label}  Read ${readText}   Write ${writeText}`;
    }

    _getDiskLabel(deviceName) {
        const vendor =
            this._readTextFile(`/sys/block/${deviceName}/device/vendor`) ?? '';
        const model =
            this._readTextFile(`/sys/block/${deviceName}/device/model`) ?? '';
        const label = `${vendor} ${model}`.replace(/\s+/g, ' ').trim();

        if (label.length > 0) {
            return `${label} (${deviceName})`;
        }

        return deviceName;
    }

    _readDiskCounters(deviceName) {
        const path = `/sys/block/${deviceName}/stat`;
        const text = this._readTextFile(path);

        if (text === null) {
            // This can happen if the disk is removed between listing and reading.
            console.warn(`NetTrack: Failed to read ${path}`);
            return null;
        }

        const fields = text.split(/\s+/).map(value =>
            Number.parseInt(value, 10)
        );
        const readSectors = fields[2];
        const writtenSectors = fields[6];

        if (
            fields.length < 7 ||
            !Number.isFinite(readSectors) ||
            !Number.isFinite(writtenSectors)
        ) {
            console.error(`NetTrack: Invalid disk stats from ${path}: ${text}`);
            return null;
        }

        return {
            readBytes: readSectors * DISK_SECTOR_SIZE_BYTES,
            writeBytes: writtenSectors * DISK_SECTOR_SIZE_BYTES,
        };
    }

    _readNetworkCounter(interfaceName, counter) {
        const path = `/sys/class/net/${interfaceName}/statistics/${counter}`;
        const text = this._readTextFile(path);

        if (text === null) {
            // This can happen if the interface goes down between listing and reading.
            console.warn(`NetTrack: Failed to read ${path}`);
            return null;
        }

        const value = Number.parseInt(text, 10);

        if (!Number.isFinite(value)) {
            console.error(`NetTrack: Invalid counter value from ${path}: ${text}`);
            return null;
        }

        return value;
    }

    _readTextFile(path) {
        try {
            const [ok, contents] = GLib.file_get_contents(path);

            if (!ok) {
                return null;
            }

            return new TextDecoder().decode(contents).trim();
        } catch (error) {
            return null;
        }
    }
}
