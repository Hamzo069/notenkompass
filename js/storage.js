/*
 * storage.js — localStorage-backed persistence shim
 *
 * Notenkompass runs entirely in the browser with no backend. All app code
 * talks to a tiny `window.storage.get/set` API (an async key-value store),
 * which this file implements on top of localStorage. Swap this file out if
 * you want to back the app with something else (IndexedDB, a sync server,
 * a browser extension storage API, ...) — nothing else in the app needs to
 * change as long as `window.storage.get(key)` resolves to `{ value }` and
 * `window.storage.set(key, value)` persists a string.
 */
(function () {
  function get(key) {
    let value = null;
    try {
      value = window.localStorage.getItem(key);
    } catch (e) {
      // localStorage can throw in private-browsing modes or when disabled.
      console.warn("notenkompass: localStorage.getItem failed", e);
    }
    return Promise.resolve({ value: value });
  }

  function set(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      console.warn("notenkompass: localStorage.setItem failed", e);
      return Promise.reject(e);
    }
    return Promise.resolve();
  }

  window.storage = { get: get, set: set };
})();
