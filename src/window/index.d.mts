/**
 * Hand-written declarations, not generated.
 *
 * Keel ships source with no build step, which is what lets Helm and Tend (plain
 * JavaScript) and Jot, Nib and Loom (TypeScript) all consume the same files. The
 * price is this file: TypeScript will not read JS out of `node_modules` without
 * `maxNodeModuleJsDepth`, and leaning on that flag to make an import typecheck is
 * the kind of obscure setting that works until someone wonders why.
 *
 * So the declarations are source too. The API here is four things; keeping them
 * in step by hand is cheaper than a `dist/` to rebuild.
 *
 * The electron shapes are described structurally rather than imported. Keel has
 * no electron dependency and should not grow one to describe two arguments.
 */

export declare const WINDOW_CHANNELS: {
  readonly minimize: 'window:minimize'
  readonly toggleMaximize: 'window:toggleMaximize'
  readonly close: 'window:close'
}

/** Just enough of a BrowserWindow for a title bar to drive it. */
export interface ControllableWindow {
  minimize(): void
  maximize(): void
  unmaximize(): void
  isMaximized(): boolean
  close(): void
}

export interface RegisterWindowControlsOptions {
  ipcMain: { on(channel: string, listener: (event: { sender: unknown }) => void): unknown }
  BrowserWindow: { fromWebContents(contents: unknown): ControllableWindow | null }
  /**
   * Override what close does. Not needed by an app that intercepts the window's
   * own `close` event - Jot hides into its tray that way.
   */
  onClose?: (window: ControllableWindow) => void
}

/**
 * Register the three messages a frameless window's header row sends.
 *
 * Acts on the window that sent the message, never on the focused one.
 */
export declare function registerWindowControls(options: RegisterWindowControlsOptions): void

export interface WindowControls {
  minimizeWindow(): void
  toggleMaximizeWindow(): void
  closeWindow(): void
}

/** The preload half: hand it `ipcRenderer`, expose the result on your bridge. */
export declare function windowControlsBridge(ipcRenderer: {
  send(channel: string, ...args: unknown[]): void
}): WindowControls
