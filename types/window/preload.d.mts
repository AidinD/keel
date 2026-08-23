/**
 * The preload half: the three functions a header row calls.
 *
 * Send, not invoke. None of them has an answer worth waiting for, and a promise
 * nobody awaits is a rejection nobody sees.
 *
 * `ipcRenderer` is injected for the same reason as in main.mjs - keel has no
 * electron dependency, and a bridge you can hand a fake to is a bridge you can
 * test.
 *
 * @param {{ send: (channel: string, ...args: unknown[]) => void }} ipcRenderer
 */
export declare function windowControlsBridge(ipcRenderer: {
    send: (channel: string, ...args: unknown[]) => void;
}): {
    minimizeWindow: () => void;
    toggleMaximizeWindow: () => void;
    closeWindow: () => void;
};
