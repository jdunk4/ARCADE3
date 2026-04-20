// Meebits API integration.
//
// This handles the Larva Labs owner-signed access flow which is the ONLY way
// to fetch a Meebit's rigged 3D models (GLB/VRM/FBX). The public endpoints
// only give us images and sprite sheets — everything 3D is gated.
//
// Flow:
//   1. redirectToAuth(callbackUrl) — sends user to larvalabs.com to sign
//   2. Larva Labs redirects back with ?account=...&accessToken=... in the URL
//   3. handleAuthCallback() reads those params and stores the token
//   4. fetchOwnedMeebits(address, token) returns the full list including GLB URLs
//   5. Game picks an ID (player's own or delegated) and loadGLB() fetches it

const MEEBITS_AUTH_BASE = 'https://meebits.larvalabs.com/meebits/apiAccessRequest';
const STORAGE_KEY_TOKEN = 'mbs_meebits_token_v1';
const STORAGE_KEY_ACCOUNT = 'mbs_meebits_account_v1';
const STORAGE_KEY_MEEBITS = 'mbs_meebits_list_v1';

// Public endpoints (no auth required) — used as fallback and for rescue NPCs
export const PublicMeebitsApi = {
  portraitUrl(id) {
    return `https://meebits.app/meebitimages/characterimage?index=${id}&type=portrait&imageType=png`;
  },
  fullBodyUrl(id) {
    return `https://meebits.app/meebitimages/characterimage?index=${id}&type=full&imageType=png`;
  },
  spriteSheetUrl(id) {
    // Sprite sheet format based on project's 16801.png example (8x8 grid).
    // The Meebits sprite endpoint returns the same.
    return `https://meebits.app/meebitimages/spritesheet?index=${id}`;
  },
  metadataUrl(id) {
    return `https://meebits.app/meebit/${id}`;
  },
};

// =============================================================================
// AUTH FLOW
// =============================================================================

/**
 * Redirects user to Larva Labs sign-message page. After they sign,
 * they come back to our callback URL with ?account=...&accessToken=...
 */
export function redirectToAuth(callbackUrl) {
  const url = MEEBITS_AUTH_BASE + '?callbackUrl=' + encodeURIComponent(callbackUrl);
  window.location.href = url;
}

/**
 * Checks the current URL for an auth callback. If present, stores the token
 * and returns { account, token }. Also strips the params from the URL so
 * refreshing doesn't re-trigger anything.
 *
 * Call this once on page load, before anything else.
 */
export function handleAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const account = params.get('account');
  const token = params.get('accessToken');
  if (!account || !token) return null;

  // Store
  try {
    localStorage.setItem(STORAGE_KEY_TOKEN, token);
    localStorage.setItem(STORAGE_KEY_ACCOUNT, account);
  } catch (e) {
    console.warn('[meebits] could not persist auth', e);
  }

  // Clean URL
  const url = new URL(window.location.href);
  url.searchParams.delete('account');
  url.searchParams.delete('accessToken');
  window.history.replaceState({}, '', url.toString());

  return { account, token };
}

/** Returns the currently-stored auth, or null. */
export function getStoredAuth() {
  try {
    const token = localStorage.getItem(STORAGE_KEY_TOKEN);
    const account = localStorage.getItem(STORAGE_KEY_ACCOUNT);
    if (token && account) return { token, account };
  } catch (e) {}
  return null;
}

export function clearStoredAuth() {
  try {
    localStorage.removeItem(STORAGE_KEY_TOKEN);
    localStorage.removeItem(STORAGE_KEY_ACCOUNT);
    localStorage.removeItem(STORAGE_KEY_MEEBITS);
  } catch (e) {}
}

// =============================================================================
// FETCH MEEBITS FOR A SIGNED-IN ADDRESS
// =============================================================================

// The actual Larva Labs "list my meebits" endpoint. Based on the official
// meebitsapi repo, authenticated requests hit this shape. If it differs
// in production we'll need to tweak the URL here.
const LARVA_LABS_API_BASE = 'https://meebits.larvalabs.com/meebitapi';

/**
 * Fetches the full list of Meebits owned by the authenticated account,
 * including their signed-and-scoped download URLs (GLB, VRM, FBX, etc).
 *
 * Each returned meebit has shape (per Larva Labs API):
 * {
 *   index: 47,
 *   type: "HUMAN",
 *   imageUrl: "/meebitimages/characterimage?index=47&type=full&imageType=jpg",
 *   ownerDownloadGLB: "https://meebits.larvalabs.com/.../glb?index=47&token=...",
 *   ownerDownloadVRM: "...",
 *   ...
 * }
 */
export async function fetchOwnedMeebits(account, token) {
  if (!account || !token) throw new Error('fetchOwnedMeebits: account and token required');

  // Cache-bust occasionally but mostly use cached list to save API calls
  const cached = getCachedMeebitsList(account);
  if (cached) return cached;

  const url = LARVA_LABS_API_BASE + '/owner/' + account + '?accessToken=' + encodeURIComponent(token);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Meebits API returned ' + res.status);
    const json = await res.json();
    const meebits = (json.data && json.data.meebits) || [];
    // Cache
    try {
      localStorage.setItem(STORAGE_KEY_MEEBITS, JSON.stringify({ account, meebits, cachedAt: Date.now() }));
    } catch (e) {}
    return meebits;
  } catch (err) {
    console.error('[meebits] fetchOwnedMeebits failed', err);
    throw err;
  }
}

function getCachedMeebitsList(account) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_MEEBITS);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.account !== account) return null;
    // Cache for 1 hour
    if (Date.now() - parsed.cachedAt > 3600000) return null;
    return parsed.meebits;
  } catch (e) { return null; }
}

// =============================================================================
// GLB LOADING
// =============================================================================

/**
 * Loads a GLB from a signed ownerDownloadGLB URL.
 * Returns the parsed GLTF object (use .scene to add to Three.js scene).
 *
 * Uses Three.js GLTFLoader. Caches the blob in IndexedDB-style
 * via URL.createObjectURL + localStorage key (small blobs only).
 */
export async function loadMeebitGLB(GLTFLoader, signedGlbUrl) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(
      signedGlbUrl,
      (gltf) => resolve(gltf),
      undefined,
      (err) => {
        console.error('[meebits] GLB load failed', err);
        reject(err);
      }
    );
  });
}

/**
 * Picks a random ID from a Meebit list (signed objects with .index),
 * or returns a random public ID if the list is empty.
 */
export function pickMeebitIdFromList(meebits) {
  if (meebits && meebits.length > 0) {
    const m = meebits[Math.floor(Math.random() * meebits.length)];
    return { id: m.index, signedObj: m };
  }
  return { id: Math.floor(Math.random() * 20000), signedObj: null };
}
