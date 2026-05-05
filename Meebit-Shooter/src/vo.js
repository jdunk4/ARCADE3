// ============================================================
// VO — Voice-over announcer system.
//
// Plays contextual voice lines at key game moments. Each line is
// a .wav file in assets/VO/. Only one VO plays at a time — new
// requests during playback are queued or dropped based on priority.
//
// Integration: import { playVO, tickVO } from './vo.js'
// Call playVO('signal_lost') at the appropriate moment.
// Call tickVO(dt) every frame to manage cooldowns.
// ============================================================

const VO_PATH = 'assets/VO/';

// ---- VO CATALOG ----
// Maps trigger keys to filenames (without path prefix).
const CATALOG = {
  // Wave / enemy type callouts
  signal_lost:        'Signal Lost.wav',
  robots:             'Robots.wav',
  ctrl_alt_delete:    'Ctrl Alt Delete.wav',
  skeletons:          'Skeletons Out of the Closet.wav',
  boom:               'BOOM.wav',
  nuke_deployed:      'Nuke Deployed.wav',
  silo_unlocked:      'Silo Unlocked.wav',
  shields_collapsing: 'Shields Collapsing.wav',
  shields_down:       'Shields are Down _ Theyre All Yours.wav',
  missile_away:       'Missle Away.wav',
  charge_complete:    'Charge Complete.wav',
  deliver_payload:    'Deliver the Payload.wav',
  over_and_out:       'Over and Out.wav',
  god_speed:          'God Speed.wav',

  // Pig / bonus wave
  whats_shaking:      'Whats Shaking Bacon.wav',
  elephants:          'Lets Talk about the Elephants in the Room.wav',

  // Visitors / beam
  beam_me_up:         'Beam Me Up.wav',

  // Dissection
  dissected:          'Dissected.wav',
  formaldehyde:       'Smell the Formaldehyde.wav',

  // Killstreaks
  cluster_clear:      'Cluster Clear.wav',
  rampage:            'Rampage.wav',
  overdrive:          'OverDrive.wav',
  god_like:           'God Like.wav',

  // Level / progression
  meebit_ascendant:   'Meebit Ascendant.wav',
  nice_work:          'Nice Work _ Over and Out.wav',
  five_four:          'Five Four Three Two One.wav',

  // Pause
  are_you_pausing:    'Are You Seriously Pausing.wav',

  // Run complete / never seen
  never_seen:         'I Have Never Seen a Run Like This.wav',
};

// ---- STATE ----
let _currentAudio = null;
let _cooldown = 0;           // seconds until next VO can play
let _lastPlayed = null;       // prevent immediate repeats
const MIN_COOLDOWN = 2.0;     // minimum seconds between VO lines
const _audioCache = new Map(); // cache HTMLAudioElement per key

// ---- PUBLIC API ----

/**
 * Play a voice-over line by key.
 * @param {string} key — one of the CATALOG keys
 * @param {number} [delay=0] — seconds to wait before playing
 * @param {boolean} [force=false] — if true, interrupt current VO
 */
export function playVO(key, delay = 0, force = false) {
  if (!CATALOG[key]) return;
  if (_cooldown > 0 && !force) return;
  if (_lastPlayed === key && _cooldown > 0) return;

  if (delay > 0) {
    setTimeout(() => _doPlay(key, force), delay * 1000);
    return;
  }
  _doPlay(key, force);
}

function _doPlay(key, force) {
  if (_cooldown > 0 && !force) return;

  // Stop current VO if force
  if (_currentAudio && force) {
    _currentAudio.pause();
    _currentAudio.currentTime = 0;
    _currentAudio = null;
  }

  // Don't overlap
  if (_currentAudio && !_currentAudio.paused) return;

  let audio = _audioCache.get(key);
  if (!audio) {
    audio = new Audio(VO_PATH + CATALOG[key]);
    audio.volume = 0.7;
    _audioCache.set(key, audio);
  }

  audio.currentTime = 0;
  const p = audio.play();
  if (p && p.catch) p.catch(() => {}); // suppress autoplay errors

  _currentAudio = audio;
  _lastPlayed = key;
  _cooldown = MIN_COOLDOWN;

  // Clear ref when done
  audio.onended = () => {
    if (_currentAudio === audio) _currentAudio = null;
  };
}

/**
 * Tick the VO cooldown. Call every frame.
 */
export function tickVO(dt) {
  if (_cooldown > 0) _cooldown = Math.max(0, _cooldown - dt);
}

/**
 * Stop any currently playing VO.
 */
export function stopVO() {
  if (_currentAudio) {
    _currentAudio.pause();
    _currentAudio.currentTime = 0;
    _currentAudio = null;
  }
}

/**
 * Play a random line from a set of keys.
 * @param {string[]} keys — array of CATALOG keys to pick from
 * @param {number} [chance=1] — probability 0-1 of actually playing
 */
export function playRandomVO(keys, chance = 1) {
  if (Math.random() > chance) return;
  const key = keys[Math.floor(Math.random() * keys.length)];
  playVO(key);
}

/** Check if a VO key exists in the catalog. */
export function hasVO(key) { return !!CATALOG[key]; }
