import {ensureDefaultProviders} from '../src/lib/services/DefaultProviders';

const enabledProviderA = {
  value: 'vega',
  display_name: 'VMovies',
  source: {author: 'Zenda-Cross', url: 'https://example.test/zenda'},
  version: '2.45',
  icon: '',
  disabled: false,
  type: 'global' as const,
  installed: false,
};

const enabledProviderB = {
  ...enabledProviderA,
  value: 'autoEmbed',
  display_name: 'MultiStream',
};

const disabledProvider = {
  ...enabledProviderA,
  value: 'multi',
  display_name: 'MultiMovies',
  disabled: true,
};

let mockSeeded = false;
let mockProviderSources: {author: string; url: string}[] = [];
let mockInstalledProviders: (typeof enabledProviderA)[] = [];
let mockStoreState = {
  provider: {value: ''} as {value: string},
  setProvider: jest.fn((p: {value: string}) => {
    mockStoreState.provider = p;
  }),
  setInstalledProviders: jest.fn(),
};

const mockFetchManifest = jest.fn();
const mockInstallProvider = jest.fn();

jest.mock('../src/lib/services/ExtensionManager', () => ({
  extensionManager: {
    fetchManifest: (...args: unknown[]) => mockFetchManifest(...args),
    installProvider: (...args: unknown[]) => mockInstallProvider(...args),
  },
}));

jest.mock('../src/lib/storage/extensionStorage', () => ({
  extensionStorage: {
    getProviderSource: jest.fn(() => mockProviderSources[0]),
    addProviderSources: jest.fn((author: string, url: string) => {
      mockProviderSources = [{author, url}];
    }),
    setDefaultProviderSource: jest.fn(),
    getInstalledProviders: jest.fn(() => mockInstalledProviders),
  },
}));

jest.mock('../src/lib/storage/StorageService', () => ({
  mainStorage: {
    getBool: jest.fn(() => mockSeeded),
    setBool: jest.fn((_key: string, value: boolean) => {
      mockSeeded = value;
    }),
  },
}));

jest.mock('../src/lib/zustand/contentStore', () => {
  const store = () => mockStoreState;
  store.getState = () => mockStoreState;
  return {__esModule: true, default: store};
});

describe('ensureDefaultProviders', () => {
  beforeEach(() => {
    mockSeeded = false;
    mockProviderSources = [];
    mockInstalledProviders = [];
    mockStoreState = {
      provider: {value: ''},
      setProvider: jest.fn((p: {value: string}) => {
        mockStoreState.provider = p;
      }),
      setInstalledProviders: jest.fn(),
    };
    mockFetchManifest.mockReset();
    mockInstallProvider.mockReset();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('configures the Zenda-Cross source and installs every non-disabled provider on a fresh install', async () => {
    mockFetchManifest.mockResolvedValue([
      enabledProviderA,
      enabledProviderB,
      disabledProvider,
    ]);
    mockInstallProvider.mockImplementation(async provider => {
      mockInstalledProviders.push({...provider, installed: true});
    });

    await ensureDefaultProviders();

    expect(mockProviderSources[0]?.author).toBe('Zenda-Cross');
    expect(mockInstallProvider).toHaveBeenCalledTimes(2);
    expect(mockInstallProvider).toHaveBeenCalledWith(enabledProviderA);
    expect(mockInstallProvider).toHaveBeenCalledWith(enabledProviderB);
    expect(mockInstallProvider).not.toHaveBeenCalledWith(disabledProvider);
    expect(mockStoreState.setInstalledProviders).toHaveBeenCalledWith(
      mockInstalledProviders,
    );
    expect(mockStoreState.setProvider).toHaveBeenCalledWith(
      mockInstalledProviders[0],
    );
  });

  it('does nothing once already seeded', async () => {
    mockSeeded = true;

    await ensureDefaultProviders();

    expect(mockFetchManifest).not.toHaveBeenCalled();
    expect(mockInstallProvider).not.toHaveBeenCalled();
  });

  it('skips seeding when providers are already installed, and marks it seeded', async () => {
    mockProviderSources = [
      {author: 'Zenda-Cross', url: 'https://example.test/zenda'},
    ];
    mockInstalledProviders = [{...enabledProviderA, installed: true}];

    await ensureDefaultProviders();

    expect(mockFetchManifest).not.toHaveBeenCalled();
    expect(mockSeeded).toBe(true);
  });

  it('does not mark seeded when the manifest fetch fails, so it can retry next launch', async () => {
    mockFetchManifest.mockRejectedValue(new Error('network down'));

    await ensureDefaultProviders();

    expect(mockSeeded).toBe(false);
    expect(mockInstallProvider).not.toHaveBeenCalled();
  });

  it('keeps going and still seeds when one provider install fails', async () => {
    mockFetchManifest.mockResolvedValue([enabledProviderA, enabledProviderB]);
    mockInstallProvider.mockImplementation(async provider => {
      if (provider.value === enabledProviderB.value) {
        throw new Error('download failed');
      }
      mockInstalledProviders.push({...provider, installed: true});
    });

    await ensureDefaultProviders();

    expect(mockSeeded).toBe(true);
    expect(mockStoreState.setInstalledProviders).toHaveBeenCalledWith(
      mockInstalledProviders,
    );
    expect(mockStoreState.setProvider).toHaveBeenCalledWith(
      mockInstalledProviders[0],
    );
  });

  it('does not override an already active provider', async () => {
    mockStoreState.provider = {value: 'existing'};
    mockFetchManifest.mockResolvedValue([enabledProviderA]);
    mockInstallProvider.mockImplementation(async provider => {
      mockInstalledProviders.push({...provider, installed: true});
    });

    await ensureDefaultProviders();

    expect(mockStoreState.setProvider).not.toHaveBeenCalled();
  });
});
