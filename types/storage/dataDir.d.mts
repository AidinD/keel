/**
 * Where an app keeps user-facing data.
 *
 * Jot and Nib had written the same eight lines with different names. The lines are
 * trivial; the reasoning behind them is not, and it is the reasoning that keeps
 * getting lost when the next app writes its own.
 *
 * **Default: Electron's userData folder.** A fresh install works with no setup and
 * a copied build stays portable.
 *
 * **Override: an environment variable.** Per-machine configuration, never baked
 * into the app. There are two reasons it exists, and both are load-bearing:
 *
 *  - It puts the data in a synced folder, which is how a laptop and a desktop
 *    share one board.
 *  - It puts the data somewhere an external tool can actually reach. A sandboxed
 *    process's writes under `%APPDATA%` are redirected into a private per-package
 *    overlay that the app never sees, while its *reads* fall through to the real
 *    filesystem - so the tool sees a file it wrote, the app does not, and both are
 *    telling the truth. Hours went into that on 2026-08-24 before the redirection
 *    was the answer. A real path on another drive has no overlay.
 *
 * What is deliberately NOT here is the "migrate the old data across" step each app
 * pairs with this. Those differ - one file versus a whole notebook - and they
 * COPY, which makes pointing the variable at a scratch folder a way to duplicate
 * real data somewhere you did not intend. That belongs next to the data it knows
 * the shape of.
 */
/**
 * @param {object} options
 * @param {string} options.variable e.g. `JOT_DATA_DIR`
 * @param {string} options.fallback Usually `app.getPath('userData')`.
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {{ dir: string, overridden: boolean, variable: string }}
 */
export declare function resolveDataDir({ variable, fallback, env }: {
    variable: string;
    fallback: string;
    env?: NodeJS.ProcessEnv;
}): {
    dir: string;
    overridden: boolean;
    variable: string;
};
