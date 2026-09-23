import {
  Image,
  SafeAreaView,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {FlashList} from '@shopify/flash-list';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {SearchStackParamList} from '../App';
import {providerManager} from '../lib/services/ProviderManager';
import {
  mergePostsRoundRobin,
  resolveFastestCandidate,
  type MergedPost,
} from '../lib/services/MultiProviderAggregator';
import {queryClient} from '../lib/client';
import useContentStore from '../lib/zustand/contentStore';
import AppText from '../components/ui/Text';
import LoadingIndicator from '../components/ui/LoadingIndicator';
import SkeletonLoader from '../components/Skeleton';
import {parseAspectRatio} from '../components/MediaPosterCard';
import {useM3Colors} from '../theme/M3PaletteContext';

type Props = NativeStackScreenProps<SearchStackParamList, 'SearchResults'>;

const GRID_POSTER_WIDTH = 100;
const GRID_SCREEN_PADDING = 16;
const GRID_ITEM_MARGIN = 12;

type GridItem = MergedPost | {resultKey: string; isSkeleton: true};

const SearchResults = ({route, navigation}: Props): React.ReactElement => {
  const colors = useM3Colors();
  const {width: windowWidth} = useWindowDimensions();
  const installedProviders = useContentStore(state => state.installedProviders);
  const [mergedResults, setMergedResults] = useState<MergedPost[]>([]);
  const [isSearching, setIsSearching] = useState(true);
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  const rawResultsRef = useRef<Record<string, {providerValue: string; posts: any[]}>>(
    {},
  );
  const abortController = useRef<AbortController | null>(null);

  const gridAvailableWidth = windowWidth - GRID_SCREEN_PADDING * 2;
  const gridColumns = Math.max(
    2,
    Math.floor(gridAvailableWidth / (GRID_POSTER_WIDTH + GRID_ITEM_MARGIN * 2)),
  );
  const gridPosterWidth =
    Math.floor(gridAvailableWidth / gridColumns) - GRID_ITEM_MARGIN * 2;

  useEffect(() => {
    if (abortController.current) {
      abortController.current.abort();
    }
    abortController.current = new AbortController();
    const signal = abortController.current.signal;

    rawResultsRef.current = {};
    setMergedResults([]);
    setIsSearching(installedProviders.length > 0);

    const recomputeMerged = () => {
      const perProvider = Object.values(rawResultsRef.current);
      setMergedResults(mergePostsRoundRobin(perProvider));
    };

    const fetchPromises = installedProviders.map(async provider => {
      try {
        const posts = await providerManager.getSearchPosts({
          searchQuery: route.params.filter,
          page: 1,
          providerValue: provider.value,
          signal,
        });
        if (signal.aborted) {
          return;
        }
        rawResultsRef.current[provider.value] = {
          providerValue: provider.value,
          posts: posts || [],
        };
        recomputeMerged();
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        console.error(`Search failed for ${provider.display_name}:`, error);
      }
    });

    Promise.allSettled(fetchPromises).then(() => {
      if (!signal.aborted) {
        setIsSearching(false);
      }
    });

    return () => {
      abortController.current?.abort();
      abortController.current = null;
    };
  }, [route.params.filter, installedProviders]);

  const handlePress = useCallback(
    async (item: MergedPost) => {
      const resultKey = `${item.title}:${item.link}`;
      if (item.candidates.length <= 1) {
        navigation.navigate('Info', {
          link: item.link,
          provider: item.provider,
          poster: item.image,
        });
        return;
      }

      setResolvingKey(resultKey);
      try {
        const winner = await resolveFastestCandidate(item.candidates);
        const target = winner || item.candidates[0];
        if (winner) {
          queryClient.setQueryData(
            ['contentInfo', winner.link, winner.provider],
            winner.meta,
          );
        }
        navigation.navigate('Info', {
          link: target.link,
          provider: target.provider,
          poster: item.image,
        });
      } finally {
        setResolvingKey(null);
      }
    },
    [navigation],
  );

  const skeletons: GridItem[] = Array.from({length: gridColumns * 3}).map(
    (_, i) => ({resultKey: `skeleton-${i}`, isSkeleton: true}),
  );
  const listData: GridItem[] =
    mergedResults.length === 0 && isSearching ? skeletons : mergedResults;

  const renderSkeletonItem = () => (
    <View className="flex flex-col m-3 items-center">
      <SkeletonLoader
        height={Math.round((gridPosterWidth * 3) / 2)}
        width={gridPosterWidth}
        marginVertical={0}
      />
      <SkeletonLoader
        height={12}
        width={gridPosterWidth}
        marginVertical={8}
      />
    </View>
  );

  return (
    <SafeAreaView className="h-full w-full bg-m3-background">
      <View className="mt-14 px-4 flex flex-row justify-between items-center gap-x-3 mb-4">
        <AppText
          role="headlineMediumEmphasized"
          className="flex-1 text-m3-on-background">
          {isSearching ? 'Searching for' : 'Results for'}{' '}
          <AppText role="headlineMediumEmphasized" style={{color: colors.primary}}>
            "{route?.params?.filter}"
          </AppText>
        </AppText>
        {isSearching && (
          <View className="flex justify-center items-center h-10 w-10">
            <LoadingIndicator size={28} />
          </View>
        )}
      </View>

      <View className="flex-1 px-1">
        <FlashList
          data={listData}
          numColumns={gridColumns}
          key={`grid-${gridColumns}`}
          contentContainerStyle={{paddingBottom: 80}}
          keyExtractor={(item, i) =>
            'isSkeleton' in item ? item.resultKey : `${item.title}-${i}`
          }
          renderItem={({item}) => {
            if ('isSkeleton' in item) {
              return renderSkeletonItem();
            }

            const resultKey = `${item.title}:${item.link}`;
            const itemRatio = parseAspectRatio(item.aspectRatio, 2 / 3);
            const cardHeight = Math.round(gridPosterWidth / itemRatio);
            const isResolving = resolvingKey === resultKey;

            return (
              <TouchableOpacity
                activeOpacity={0.78}
                disabled={resolvingKey !== null}
                className="flex flex-col m-3 items-center"
                onPress={() => handlePress(item)}>
                <View
                  style={{
                    position: 'relative',
                    width: gridPosterWidth,
                    height: cardHeight,
                    borderRadius: 10,
                    overflow: 'hidden',
                    backgroundColor: colors.surfaceContainerHigh,
                  }}>
                  <Image
                    source={{
                      uri:
                        item.image ||
                        'https://placehold.jp/24/363636/ffffff/100x150.png?text=Vega',
                    }}
                    resizeMode="cover"
                    style={{width: '100%', height: '100%'}}
                  />
                  {isResolving && (
                    <View
                      style={{
                        position: 'absolute',
                        inset: 0,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: 'rgba(0,0,0,0.45)',
                      }}>
                      <LoadingIndicator size={28} />
                    </View>
                  )}
                </View>
                <AppText
                  role="bodySmall"
                  numberOfLines={2}
                  style={{width: gridPosterWidth, marginTop: 6}}
                  className="text-m3-on-surface text-center">
                  {item.title}
                </AppText>
              </TouchableOpacity>
            );
          }}
        />
        {!isSearching && mergedResults.length === 0 ? (
          <View className="w-full h-full flex items-center justify-center">
            <AppText
              role="titleLargeEmphasized"
              className="text-center text-m3-on-surface-variant">
              No Content Found
            </AppText>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
};

export default SearchResults;
