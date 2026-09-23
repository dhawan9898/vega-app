import {extensionManager} from './ExtensionManager';
import {extensionStorage} from '../storage/extensionStorage';
import {createProviderSource} from '../utils/helpers';
import {mainStorage} from '../storage/StorageService';
import useContentStore from '../zustand/contentStore';

const DEFAULT_PROVIDER_SOURCE_AUTHOR = 'Zenda-Cross';
const DEFAULT_PROVIDERS_SEEDED_KEY = 'defaultProvidersSeeded';
const INSTALL_CONCURRENCY = 5;

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
    // Reaching the source successfully counts as seeded; individual
    // install failures below are logged and left for the user to retry
    // from the Extensions screen rather than blocking future attempts.
    mainStorage.setBool(DEFAULT_PROVIDERS_SEEDED_KEY, true);

    const toInstall = manifestProviders.filter(provider => !provider.disabled);
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
