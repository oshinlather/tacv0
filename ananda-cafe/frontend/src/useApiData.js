// ─────────────────────────────────────────────────────────────────────────────
//  useApiData — stale-while-revalidate data layer (Phase 1 of the "smooth dashboard")
// ─────────────────────────────────────────────────────────────────────────────
// Goal: on refresh / tab-switch, paint INSTANTLY from a local cache, then quietly
// refetch in the background and re-render with fresh numbers — no "⏳ Loading…" spinner
// on a revisit. A prior cache attempt was removed after it got blamed during an unrelated
// auth outage, so this one is built defensively:
//   • NEVER caches an error / non-OK response (the fetcher rejects → cached data is kept,
//     nothing is stored). A backend hiccup can't poison the cache.
//   • Per-user namespace (keyed by the logged-in id) so data never crosses users.
//   • sessionStorage writes are size-capped + try/caught (quota/private-mode safe).
//   • A global SWR_ENABLED kill-switch degrades the hook to plain fetch-on-mount.
// Writes bust the store via invalidateAll() (wired from api.js post/patch/del), and in
// Phase 2 a Socket.IO "changed" event will call invalidate(prefix) for live updates.
//
// Contract: the `key` encodes EVERYTHING that should trigger a refetch (date, outlet,
// basis, …) — e.g. `pnl:${dateStr}:${outlet}`. The `fetcher` returns the exact shape the
// component needs (it may Promise.all + transform first).

import { useState, useLayoutEffect, useRef, useCallback } from "react";

export let SWR_ENABLED = true;
export function setSwrEnabled(v) { SWR_ENABLED = !!v; } // escape hatch if anything misbehaves

const PREFIX = "ananda_swr";
const MAX_PERSIST_BYTES = 256 * 1024; // bigger payloads stay in memory only

const uid = () => {
  try { return JSON.parse(localStorage.getItem("ananda_user") || "{}")?.id || "anon"; }
  catch (e) { return "anon"; }
};
const nsPrefix = () => `${PREFIX}:${uid()}:`;

const mem = new Map();       // key -> data (component-shaped)
const inflight = new Map();  // key -> Promise<data> (collapse concurrent revalidations)
const subs = new Map();      // key -> Set<listener>

function readStore(key) {
  if (mem.has(key)) return mem.get(key);
  try {
    const raw = sessionStorage.getItem(nsPrefix() + key);
    if (raw != null) { const d = JSON.parse(raw); mem.set(key, d); return d; }
  } catch (e) { /* ignore */ }
  return undefined;
}
function writeStore(key, data) {
  mem.set(key, data);
  try {
    const s = JSON.stringify(data);
    if (s.length <= MAX_PERSIST_BYTES) sessionStorage.setItem(nsPrefix() + key, s);
    else sessionStorage.removeItem(nsPrefix() + key); // too big → mem-only, drop any old copy
  } catch (e) { /* quota / non-serializable → mem-only */ }
}
function emit(key) {
  const set = subs.get(key);
  if (set) [...set].forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
}

// Run the fetcher for `key`, de-duping concurrent calls. On success: store + broadcast.
// On error: reject (do NOT store) so callers keep showing cached data.
function revalidate(key, fetcher) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve().then(fetcher)
    .then((data) => { writeStore(key, data); emit(key); return data; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// Drop every entry whose key starts with `prefix` (mem + sessionStorage) and nudge any
// mounted hooks for those keys to refetch. Used by Phase 2 sockets for scoped invalidation.
export function invalidate(prefix) {
  for (const k of [...mem.keys()]) if (k.startsWith(prefix)) mem.delete(k);
  try {
    const p = nsPrefix();
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const sk = sessionStorage.key(i);
      if (sk && sk.startsWith(p) && sk.slice(p.length).startsWith(prefix)) sessionStorage.removeItem(sk);
    }
  } catch (e) { /* ignore */ }
  for (const k of [...subs.keys()]) if (k.startsWith(prefix)) emit(k);
}

// Wipe the whole SWR store (all users) and make every mounted hook refetch. Called on every
// write (api.js) and on login/logout, so a save/login is never followed by stale data.
export function invalidateAll() {
  mem.clear();
  try {
    const p = `${PREFIX}:`;
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const sk = sessionStorage.key(i);
      if (sk && sk.startsWith(p)) sessionStorage.removeItem(sk);
    }
  } catch (e) { /* ignore */ }
  for (const k of [...subs.keys()]) emit(k);
}

export function useApiData(key, fetcher, opts = {}) {
  const initialLoading = opts.initialLoading ?? true;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher; // always call the latest closure (fresh outlet/date/etc.)

  const [state, setState] = useState(() => {
    const cached = SWR_ENABLED ? readStore(key) : undefined;
    return { data: cached, loading: cached === undefined ? initialLoading : false, error: null };
  });

  // useLayoutEffect so the switch to a new key's cached value happens BEFORE paint — no
  // flash of the previous key's data when the date/outlet changes.
  useLayoutEffect(() => {
    let cancelled = false;

    if (!SWR_ENABLED) {
      setState({ data: undefined, loading: initialLoading, error: null });
      Promise.resolve().then(() => fetcherRef.current())
        .then((d) => { if (!cancelled) setState({ data: d, loading: false, error: null }); })
        .catch((e) => { if (!cancelled) setState((s) => ({ ...s, loading: false, error: e })); });
      return () => { cancelled = true; };
    }

    // 1. Instant paint from cache for THIS key.
    const cached = readStore(key);
    setState({ data: cached, loading: cached === undefined ? initialLoading : false, error: null });

    // 2. Re-render when this key's store changes (our own revalidate, another mount, a write
    //    invalidation, or a Phase-2 socket event). If it was invalidated to empty, refetch.
    const listener = () => {
      if (cancelled) return;
      const latest = readStore(key);
      if (latest !== undefined) {
        setState({ data: latest, loading: false, error: null });
      } else {
        setState((s) => ({ data: undefined, loading: true, error: s.error }));
        revalidate(key, () => fetcherRef.current())
          .catch((e) => { if (!cancelled) setState((s) => ({ ...s, loading: false, error: e })); });
      }
    };
    let set = subs.get(key);
    if (!set) { set = new Set(); subs.set(key, set); }
    set.add(listener);

    // 3. Background revalidate on mount. Success broadcasts via emit() → listener re-renders
    //    from the fresh store value; failure keeps the cached data and surfaces the error.
    revalidate(key, () => fetcherRef.current())
      .catch((e) => { if (!cancelled) setState((s) => ({ data: s.data, loading: false, error: e })); });

    return () => {
      cancelled = true;
      set.delete(listener);
      if (set.size === 0) subs.delete(key);
    };
  }, [key]); // key encodes all inputs; changing it re-reads cache + revalidates

  const refetch = useCallback(() => revalidate(key, () => fetcherRef.current()).catch(() => {}), [key]);

  return { data: state.data, loading: state.loading, error: state.error, refetch };
}
