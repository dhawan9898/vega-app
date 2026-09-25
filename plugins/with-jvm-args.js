const {withGradleProperties} = require('expo/config-plugins');

// Keep the Gradle daemon within a memory budget that fits alongside the Kotlin
// compiler workers and Metro. A 4GB heap starves memory-constrained hosts
// (e.g. WSL2) and causes the VM to be OOM-killed mid-build. CI runners
// typically have more headroom than that, so GRADLE_JVM_HEAP_MB lets the
// workflow raise it there - R8 minification + packaging on this app's many
// native modules (Firebase, video, torrent, WARP, ByeDPI, reanimated, ...)
// runs out of heap on the 3072m default with a release build.
const heapMb = Number(process.env.GRADLE_JVM_HEAP_MB) || 3072;
// Metaspace and the Kotlin daemon weren't what ran out - only the main
// heap was ("Java heap space" during :app:packageRelease, after Kotlin
// compilation had already finished). Cap their scale-up so raising the
// main heap for CI doesn't also inflate two other JVMs' worth of
// headroom that were never the problem, on a runner with finite RAM.
const metaspaceMb = Math.min(1024, Math.round(heapMb / 4));
const kotlinDaemonHeapMb = Math.min(1536, Math.round(heapMb / 2));

const GRADLE_PROPERTIES = {
  'org.gradle.jvmargs': `-Xmx${heapMb}m -XX:MaxMetaspaceSize=${metaspaceMb}m`,
  // Cap concurrent Gradle workers so parallel module builds don't spike RAM.
  'org.gradle.workers.max': '4',
  // Bound the Kotlin daemon heap; it otherwise sizes to the host and adds up.
  'kotlin.daemon.jvmargs': `-Xmx${kotlinDaemonHeapMb}m`,
};

function upsertProperty(modResults, key, value) {
  const existing = modResults.find(
    item => item.type === 'property' && item.key === key,
  );
  if (existing) {
    existing.value = value;
  } else {
    modResults.push({type: 'property', key, value});
  }
}

module.exports = function withJvmArgs(config) {
  return withGradleProperties(config, cfg => {
    for (const [key, value] of Object.entries(GRADLE_PROPERTIES)) {
      upsertProperty(cfg.modResults, key, value);
    }
    return cfg;
  });
};
