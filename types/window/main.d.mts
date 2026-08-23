/**
 * The main-process half of a frameless window's title bar.
 *
 * Every app in the suite is frameless, so every app has to answer three messages
 * from its header row. Five of them had written it out by hand, and they had not
 * all written the same thing: Tend reached for `BrowserWindow.getFocusedWindow()`,
 * which acts on whatever window happens to be focused rather than on the one that
 * asked. That is invisible with a single window and wrong the moment there are
 * two - or when the click arrives from automation while focus sits elsewhere.
 *
 * `fromWebContents(event.sender)` is the correct form, and making it the default
 * is most of the point of this module existing.
 *
 * Electron is injected rather than imported. Keel is a plain package with no
 * electron dependency of its own, which keeps it testable with two object
 * literals and keeps it out of every app's packaging decisions.
 */
/**
 * Annotated rather than inferred: without this the generated declarations widen
 * these to `string`, and a consumer comparing against a channel name loses the
 * one check that would catch a typo.
 *
 * @type {{ readonly minimize: 'window:minimize', readonly toggleMaximize: 'window:toggleMaximize', readonly close: 'window:close' }}
 */
export declare const WINDOW_CHANNELS: {
    readonly minimize: 'window:minimize';
    readonly toggleMaximize: 'window:toggleMaximize';
    readonly close: 'window:close';
};
/**
 * Register the three handlers a frameless window needs.
 *
 * @param {object} deps
 * @param {{ on: (channel: string, listener: (event: any) => void) => void }} deps.ipcMain
 * @param {{ fromWebContents: (contents: any) => any }} deps.BrowserWindow
 * @param {(window: any) => void} [deps.onClose] Override what close does. Jot
 *   hides into the tray instead of closing; it does that in the window's own
 *   `close` handler, so it does not need this - but an app that wants to decide
 *   per-window can.
 */
export declare function registerWindowControls({ ipcMain, BrowserWindow, onClose }: {
    ipcMain: {
        on: (channel: string, listener: (event: any) => void) => void;
    };
    BrowserWindow: {
        fromWebContents: (contents: any) => any;
    };
    onClose?: (window: any) => void;
}): void;
