--- v2_orig/animation.js	2026-04-23 03:42:45.283483629 +0000
+++ v2_new/animation.js	2026-04-23 03:43:37.542465301 +0000
@@ -159,6 +159,16 @@
  * `mesh` must be the scene root returned by SkeletonUtils.clone (civilians)
  * or the player's loaded avatar root.
  *
+ * `opts.restPoseCompensation` — set to `true` for rigs whose rest (bind)
+ * pose is NOT a straight T-pose. The Larva-Labs Meebit GLB is the main
+ * example: it ships with HipsBone pre-rotated 180° around Y, legs and
+ * shoulders pre-rotated 180° around other axes. Mixamo animation data
+ * assumes rest = identity everywhere, so applying it directly to these
+ * bones folds the character into a ball. When this option is on, every
+ * rotation track on the mixer gets pre-multiplied by the target bone's
+ * rest quaternion at action-creation time, so the animation plays
+ * "on top of" the rest pose instead of replacing it.
+ *
  * Returns:
  *   {
  *     update(dt),            // call every frame
@@ -167,16 +177,29 @@
  *     ready: true|false      // false if no clips are loaded yet
  *   }
  */
-export function attachMixer(mesh) {
+export function attachMixer(mesh, opts = {}) {
   const mixer = new THREE.AnimationMixer(mesh);
   const actions = {};
   let current = null;
 
+  // Cache of rest quaternions, keyed by bone name. Only populated when
+  // restPoseCompensation is requested.
+  const restByBone = opts.restPoseCompensation ? _collectRestPose(mesh) : null;
+
   function getAction(key) {
     if (actions[key]) return actions[key];
     const clip = _clipCache[key];
     if (!clip) return null;
-    const action = mixer.clipAction(clip);
+
+    // Rest-pose compensation: build a clip variant whose rotation
+    // keyframes have been pre-multiplied by each bone's rest quaternion.
+    // We cache per-(clip,mesh) so repeated playback reuses the same clip
+    // without rebuilding every time.
+    const effectiveClip = restByBone
+      ? _buildCompensatedClip(clip, restByBone)
+      : clip;
+
+    const action = mixer.clipAction(effectiveClip);
     action.setLoop(THREE.LoopRepeat, Infinity);
     actions[key] = action;
     return action;
@@ -235,3 +258,101 @@
 export function animationsReady() {
   return Object.keys(_clipCache).length > 0;
 }
+
+// ============================================================================
+// REST-POSE COMPENSATION HELPERS
+// ============================================================================
+// The Larva-Labs Meebit GLB ships with a bind (rest) pose that is NOT a
+// T-pose: its HipsBone is rotated 180° around Y, legs are pre-rotated 180°
+// around their roll axes, shoulders have custom pre-rotations, etc. When
+// you apply a Mixamo-sourced rotation track (which assumes rest = identity)
+// directly to these bones, the motion "replaces" the rest rotation and the
+// character folds into a ball.
+//
+// Fix: for each rotation keyframe on bone B, store `Q_rest * Q_keyframe`
+// instead of just `Q_keyframe`. Since the Mixamo source's own rest is
+// identity, this reduces to a left-multiply of each keyframe by the
+// target bone's rest quaternion.
+//
+// We build a bespoke AnimationClip per (clip, bone-set) so the rest of
+// the mixer code doesn't need to know about compensation.
+// ============================================================================
+
+/**
+ * Walk the mesh tree and collect rest-pose quaternions keyed by bone name.
+ * Called once per attachMixer() when compensation is requested.
+ */
+function _collectRestPose(mesh) {
+  const map = {};
+  mesh.traverse(o => {
+    if (o.isBone && o.name) {
+      // First occurrence wins — if there are duplicate bone names we
+      // wouldn't be able to disambiguate anyway (three.js tracks match
+      // by name only).
+      if (!map[o.name]) map[o.name] = o.quaternion.clone();
+    }
+  });
+  return map;
+}
+
+// Small per-clip cache so repeated play of the same clip on the same rig
+// doesn't rebuild the compensated clip each time. Keyed by the raw clip
+// object identity.
+const _compensatedClipCache = new WeakMap();  // WeakMap<clip, WeakMap<restMap, compensatedClip>>
+
+function _buildCompensatedClip(rawClip, restByBone) {
+  // Second-level cache — the restByBone object is unique per mixer, so it
+  // suffices as the inner key. WeakMap avoids leaking when the mesh is GC'd.
+  let inner = _compensatedClipCache.get(rawClip);
+  if (!inner) {
+    inner = new WeakMap();
+    _compensatedClipCache.set(rawClip, inner);
+  }
+  const cached = inner.get(restByBone);
+  if (cached) return cached;
+
+  const tracks = [];
+  const _q = new THREE.Quaternion();
+  const _qOut = new THREE.Quaternion();
+
+  for (const track of rawClip.tracks) {
+    // Only rotation tracks need compensation. Position/scale tracks pass
+    // through unchanged (we already stripped hip position upstream).
+    const dot = track.name.indexOf('.');
+    const boneName = dot >= 0 ? track.name.slice(0, dot) : track.name;
+    const property = dot >= 0 ? track.name.slice(dot + 1) : '';
+    const rest = restByBone[boneName];
+
+    if (!rest || property !== 'quaternion') {
+      tracks.push(track);
+      continue;
+    }
+
+    // track.values is a flat Float32Array of [x,y,z,w, x,y,z,w, ...].
+    // Clone it, then for each keyframe compute rest * keyframe.
+    const values = track.values.slice(0);  // typed-array copy
+    for (let i = 0; i < values.length; i += 4) {
+      _q.set(values[i], values[i+1], values[i+2], values[i+3]);
+      _qOut.copy(rest).multiply(_q);
+      values[i]   = _qOut.x;
+      values[i+1] = _qOut.y;
+      values[i+2] = _qOut.z;
+      values[i+3] = _qOut.w;
+    }
+
+    const compTrack = new THREE.QuaternionKeyframeTrack(
+      track.name,
+      track.times,   // shared — immutable usage pattern
+      values,
+    );
+    tracks.push(compTrack);
+  }
+
+  const clip = new THREE.AnimationClip(
+    rawClip.name + '-restComp',
+    rawClip.duration,
+    tracks,
+  );
+  inner.set(restByBone, clip);
+  return clip;
+}
