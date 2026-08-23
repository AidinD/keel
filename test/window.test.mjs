import { test } from 'node:test'
import assert from 'node:assert/strict'

import { registerWindowControls, windowControlsBridge, WINDOW_CHANNELS } from '../src/window/index.mjs'

/** A stand-in for electron's ipcMain that just records and replays listeners. */
function fakeIpcMain() {
  const listeners = new Map()
  return {
    on(channel, listener) {
      listeners.set(channel, listener)
    },
    channels: () => [...listeners.keys()],
    fire(channel, event) {
      const listener = listeners.get(channel)
      if (listener === undefined) {
        throw new Error(`nothing listening on ${channel}`)
      }
      listener(event)
    }
  }
}

/** A stand-in for a BrowserWindow that records what was done to it. */
function fakeWindow({ maximized = false } = {}) {
  return {
    calls: [],
    isMaximized: () => maximized,
    minimize() {
      this.calls.push('minimize')
    },
    maximize() {
      this.calls.push('maximize')
    },
    unmaximize() {
      this.calls.push('unmaximize')
    },
    close() {
      this.calls.push('close')
    }
  }
}

/** Resolves a window from the sender, the way electron does. */
function fakeBrowserWindow(map) {
  return { fromWebContents: (contents) => map.get(contents) ?? null }
}

test('it registers exactly the three channels a title bar needs', () => {
  const ipcMain = fakeIpcMain()
  registerWindowControls({ ipcMain, BrowserWindow: fakeBrowserWindow(new Map()) })
  assert.deepEqual(ipcMain.channels().sort(), [
    WINDOW_CHANNELS.close,
    WINDOW_CHANNELS.minimize,
    WINDOW_CHANNELS.toggleMaximize
  ].sort())
})

test('it acts on the window that asked, not on the focused one', () => {
  // The bug this module exists to remove: Tend used getFocusedWindow(), so with
  // two windows open the wrong one got minimised.
  const asking = fakeWindow()
  const other = fakeWindow()
  const ipcMain = fakeIpcMain()
  registerWindowControls({
    ipcMain,
    BrowserWindow: fakeBrowserWindow(new Map([['contents-A', asking], ['contents-B', other]]))
  })

  ipcMain.fire(WINDOW_CHANNELS.minimize, { sender: 'contents-A' })

  assert.deepEqual(asking.calls, ['minimize'])
  assert.deepEqual(other.calls, [], 'the other window is untouched')
})

test('toggleMaximize maximises a restored window and restores a maximised one', () => {
  for (const [maximized, expected] of [[false, 'maximize'], [true, 'unmaximize']]) {
    const window = fakeWindow({ maximized })
    const ipcMain = fakeIpcMain()
    registerWindowControls({
      ipcMain,
      BrowserWindow: fakeBrowserWindow(new Map([['c', window]]))
    })
    ipcMain.fire(WINDOW_CHANNELS.toggleMaximize, { sender: 'c' })
    assert.deepEqual(window.calls, [expected], `maximized=${maximized}`)
  }
})

test('close is a plain close, so a tray app can still intercept it', () => {
  // Jot hides into the tray from the window's own close handler. This module must
  // not know or care - it just closes.
  const window = fakeWindow()
  const ipcMain = fakeIpcMain()
  registerWindowControls({ ipcMain, BrowserWindow: fakeBrowserWindow(new Map([['c', window]])) })
  ipcMain.fire(WINDOW_CHANNELS.close, { sender: 'c' })
  assert.deepEqual(window.calls, ['close'])
})

test('onClose overrides what close does, and gets the right window', () => {
  const window = fakeWindow()
  const seen = []
  const ipcMain = fakeIpcMain()
  registerWindowControls({
    ipcMain,
    BrowserWindow: fakeBrowserWindow(new Map([['c', window]])),
    onClose: (w) => seen.push(w)
  })
  ipcMain.fire(WINDOW_CHANNELS.close, { sender: 'c' })
  assert.deepEqual(seen, [window])
  assert.deepEqual(window.calls, [], 'the default close did not also run')
})

test('a message from a window that has gone away is ignored, not thrown', () => {
  // The renderer can outlive its window by a frame during teardown.
  const ipcMain = fakeIpcMain()
  registerWindowControls({ ipcMain, BrowserWindow: fakeBrowserWindow(new Map()) })
  for (const channel of Object.values(WINDOW_CHANNELS)) {
    assert.doesNotThrow(() => ipcMain.fire(channel, { sender: 'gone' }), channel)
  }
})

test('it refuses to be set up without electron rather than failing later', () => {
  assert.throws(() => registerWindowControls({}), /needs \{ ipcMain, BrowserWindow \}/)
  assert.throws(() => windowControlsBridge(undefined), /needs ipcRenderer/)
})

test('the bridge sends on the same channels main listens to', () => {
  const sent = []
  const bridge = windowControlsBridge({ send: (channel) => sent.push(channel) })

  bridge.minimizeWindow()
  bridge.toggleMaximizeWindow()
  bridge.closeWindow()

  assert.deepEqual(sent, [
    WINDOW_CHANNELS.minimize,
    WINDOW_CHANNELS.toggleMaximize,
    WINDOW_CHANNELS.close
  ])
})

test('the bridge returns nothing, because none of it is worth awaiting', () => {
  const bridge = windowControlsBridge({ send: () => {} })
  for (const fn of Object.values(bridge)) {
    assert.equal(fn(), undefined)
  }
})

test('the bridge and the handlers agree, wired end to end', () => {
  const window = fakeWindow()
  const ipcMain = fakeIpcMain()
  registerWindowControls({ ipcMain, BrowserWindow: fakeBrowserWindow(new Map([['c', window]])) })

  // Route the bridge's sends straight into the handlers, as electron would.
  const bridge = windowControlsBridge({ send: (channel) => ipcMain.fire(channel, { sender: 'c' }) })
  bridge.minimizeWindow()
  bridge.closeWindow()

  assert.deepEqual(window.calls, ['minimize', 'close'])
})
