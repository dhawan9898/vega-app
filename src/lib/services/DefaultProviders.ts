import {extensionManager} from './ExtensionManager';
import {extensionStorage} from '../storage/extensionStorage';
import {createProviderSource} from '../utils/helpers';
import {mainStorage} from '../storage/StorageService';
import useContentStore from '../zustand/contentStore';

const DEFAULT_PROVIDER_SOURCE_AUTHOR = 'Zenda-Cross';
const DEFAULT_PROVIDERS_SEEDED_KEY = 'defaultProvidersSeeded';
// Each provider install fans out into several concurrent file downloads
// (posts/meta/stream/catalog/episodes/settings); keeping this modest limits
// how many raw.githubusercontent.com requests are in flight at once during
// the bulk first-run install, which otherwise risks timeouts/rate limiting
// that can fail every provider in a batch at once.
const INSTALL_CONCURRENCY = 3;

/**
 * On a fresh install (no provider source configured, nothing installed yet),
 * point the app at the official Zenda-Cross/vega-providers source and
 * install every provider it doesn't mark as disabled, so the app is usable
 * without the user having to add a source and install providers by hand.
 * Runs at most once per install; a failed manifest fetch (e.g. no network
 * on first launch) is retried on the next app start instead of being
 * marked as seeded.
 */
export async function ensureDefaultProviders(): Promise<void> {
  if (mainStorage.getBool(DEFAULT_PROVIDERS_SEEDED_KEY)) {
    return;
  }

  try {
    let source = extensionStorage.getProviderSource();
    if (!source) {
      const created = createProviderSource(DEFAULT_PROVIDER_SOURCE_AUTHOR);
      extensionStorage.addProviderSources(created.author, created.url);
      extensionStorage.setDefaultProviderSource(created.author);
      source = extensionStorage.getProviderSource();
    }

    if (!source) {
      return;
    }

    if (extensionStorage.getInstalledProviders().length > 0) {
      // User already has providers installed - nothing to seed.
      mainStorage.setBool(DEFAULT_PROVIDERS_SEEDED_KEY, true);
      return;
    }

    const manifestProviders = await extensionManager.fetchManifest(
      source,
      false,
    );

    const toInstall = manifestProviders.filter(provider => !provider.disabled);
    if (toInstall.length === 0) {
      // The source itself has nothing enabled to install - nothing more we
      // can do automatically, so don't keep retrying this every launch.
      mainStorage.setBool(DEFAULT_PROVIDERS_SEEDED_KEY, true);
      return;
    }

    for (let i = 0; i < toInstall.length; i += INSTALL_CONCURRENCY) {
      const batch = toInstall.slice(i, i + INSTALL_CONCURRENCY);
      await Promise.all(
        batch.map(provider =>
          extensionManager.installProvider(provider).catch(error => {
            console.warn(
              `[DefaultProviders] Failed to install ${provider.value}:`,
              error,
            );
          }),
        ),
      );
    }

    const installedAfter = extensionStorage.getInstalledProviders();
    // Only mark as seeded once at least one provider actually landed. This
    // runs at most once per install, so if a transient failure (rate
    // limiting, a network blip mid-install) left every install failing,
    // marking it seeded anyway would permanently strand the user with an
    // empty app and no automatic retry - only leaving it unseeded lets the
    // next app launch try again.
    if (installedAfter.length > 0) {
      mainStorage.setBool(DEFAULT_PROVIDERS_SEEDED_KEY, true);
    }

    useContentStore.getState().setInstalledProviders(installedAfter);
    if (
      !useContentStore.getState().provider?.value &&
      installedAfter.length > 0
    ) {
      useContentStore.getState().setProvider(installedAfter[0]);
    }
  } catch (error) {
    console.warn('[DefaultProviders] Failed to seed default providers:', error);
  }
}
