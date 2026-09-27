import {SafeAreaView, ScrollView, RefreshControl, View} from 'react-native';
import Slider from '../../components/Slider';
import React, {useCallback, useMemo, useState} from 'react';
import {useFocusEffect} from '@react-navigation/native';
import HeroOptimized from '../../components/Hero';
import useContentStore from '../../lib/zustand/contentStore';
import useHeroStore from '../../lib/zustand/herostore';
import {syncFromSharedFolder} from '../../lib/sync/syncService';
import {
  useHomePageData,
  useCategoryCatalog,
  useCategoryHomeData,
  getRandomHeroPost,
  clearHeroCache,
} from '../../lib/hooks/useHomePageData';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {HomeStackParamList} from '../../App';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {HOME_SECTION_TITLES} from '../../lib/getHomepagedata';
import Tutorial from '../../components/Touturial';
import {QueryErrorBoundary} from '../../components/ErrorBoundary';
import {StatusBar} from 'expo-status-bar';
import AppText from '../../components/ui/Text';
import {useM3Colors} from '../../theme/M3PaletteContext';
import ContinueWatching from '../../components/ContinueWatching';
import StatusBarScrim from '../../components/ui/StatusBarScrim';
import CategoryBar, {
  FOR_YOU_CATEGORY_ID,
} from '../../components/home/CategoryBar';

type Props = NativeStackScreenProps<HomeStackParamList, 'Home'>;

const Home = ({}: Props) => {
  const colors = useM3Colors();
  const [statusBarScrimVisible, setStatusBarScrimVisible] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [isAtTop, setIsAtTop] = useState(true);

  const installedProviders = useContentStore(state => state.installedProviders);
  const setHero = useHeroStore(state => state.setHero);
  const [selectedCategoryId, setSelectedCategoryId] =
    useState<string>(FOR_YOU_CATEGORY_ID);

  // React Query for home page data, aggregated across every installed
  // provider rather than a single manually-selected one.
  const {
    data: homeData = [],
    isLoading,
    error,
    refetch,
    isRefetching,
    // isStale,
  } = useHomePageData({
    installedProviders,
    enabled: !!installedProviders?.length,
  });

  // Netflix-style top bar: "For You" plus Movies / TV Shows / genre chips
  // discovered across every installed provider's own catalog and genres.
  const {data: categoryCatalog} = useCategoryCatalog({
    installedProviders,
    enabled: !!installedProviders?.length,
  });
  const categoryOptions = useMemo(
    () => categoryCatalog?.options ?? [],
    [categoryCatalog],
  );
  const selectedCategory = useMemo(
    () =>
      selectedCategoryId === FOR_YOU_CATEGORY_ID
        ? null
        : categoryOptions.find(option => option.id === selectedCategoryId) ??
          null,
    [categoryOptions, selectedCategoryId],
  );
  const selectedCategoryFilters = useMemo(
    () =>
      (selectedCategory &&
        categoryCatalog?.filtersByCategory.get(selectedCategory.id)) ||
      [],
    [categoryCatalog, selectedCategory],
  );
  const {
    data: categoryData,
    isLoading: isCategoryLoading,
    error: categoryError,
  } = useCategoryHomeData({
    category: selectedCategory,
    providerFilters: selectedCategoryFilters,
    enabled: !!selectedCategory,
  });

  // Reset back to "For You" if the currently selected chip disappears (e.g.
  // providers changed and no longer expose that genre).
  React.useEffect(() => {
    if (
      selectedCategoryId !== FOR_YOU_CATEGORY_ID &&
      categoryCatalog &&
      !categoryOptions.some(option => option.id === selectedCategoryId)
    ) {
      setSelectedCategoryId(FOR_YOU_CATEGORY_ID);
    }
  }, [categoryCatalog, categoryOptions, selectedCategoryId]);

  // Memoized scroll handler
  const handleScroll = useCallback((event: any) => {
    const offsetY = event.nativeEvent?.contentOffset?.y ?? 0;
    setStatusBarScrimVisible(offsetY > 12);
    setIsAtTop(offsetY <= 0);
  }, []);

  // Stable hero post calculation - aggregated data uses a fixed cache key
  // since it is no longer tied to a single selected provider.
  const heroPost = useMemo(() => {
    if (!homeData || homeData.length === 0) {
      return null;
    }
    return getRandomHeroPost(homeData, 'aggregated');
  }, [homeData]);

  // Update hero only when hero post actually changes
  React.useEffect(() => {
    if (heroPost) {
      setHero(heroPost);
    } else {
      setHero({link: '', image: '', title: ''});
    }
  }, [heroPost, setHero]);

  useFocusEffect(
    useCallback(() => {
      syncFromSharedFolder().catch(e =>
        console.warn('[VegaSync] Home focus sync failed:', e),
      );
    }, []),
  );

  // Optimized refresh handler
  const handleRefresh = useCallback(async () => {
    setManualRefreshing(true);
    try {
      // Clear hero cache to get a new random hero on refresh
      clearHeroCache('aggregated');
      await Promise.race([
        Promise.allSettled([
          refetch(),
          syncFromSharedFolder().catch(e =>
            console.warn('[VegaSync] Home refresh sync failed:', e),
          ),
        ]),
        new Promise(resolve => setTimeout(resolve, 10000)),
      ]);
    } catch (refreshError) {
      console.error('Error refreshing home data:', refreshError);
    } finally {
      setTimeout(() => {
        setManualRefreshing(false);
      }, 50);
    }
  }, [refetch]);

  // Section titles are fixed (aggregated across providers), so the loading
  // skeleton can render immediately instead of waiting on a catalog fetch.
  const loadingSliders = useMemo(
    () =>
      HOME_SECTION_TITLES.map((title, index) => (
        <Slider
          isLoading={true}
          key={`loading-${title}-${index}`}
          title={title}
          posts={[]}
          filter={title}
        />
      )),
    [],
  );

  // Memoized content sliders
  const contentSliders = useMemo(() => {
    return homeData.map((item, index) => (
      <Slider
        isLoading={false}
        key={`content-${item.filter}-${index}`}
        title={item.title}
        posts={item.Posts}
        filter={item.filter}
      />
    ));
  }, [homeData]);

  // When a category chip other than "For You" is selected, show its single
  // merged section instead of the default aggregated feed.
  const categorySlider = useMemo(() => {
    if (!selectedCategory) {
      return null;
    }
    return (
      <Slider
        isLoading={isCategoryLoading && !categoryData}
        key={`category-${selectedCategory.id}`}
        title={selectedCategory.label}
        posts={categoryData?.Posts ?? []}
        filter={selectedCategory.id}
      />
    );
  }, [selectedCategory, isCategoryLoading, categoryData]);

  const activeError = selectedCategory ? categoryError : error;
  const activeIsLoading = selectedCategory ? isCategoryLoading : isLoading;
  const activeHasData = selectedCategory
    ? (categoryData?.Posts.length ?? 0) > 0
    : homeData.length > 0;

  // Memoized error message - only show if there is no cached data and an error occurred
  const errorComponent = useMemo(() => {
    if (activeHasData || activeIsLoading || !activeError) {
      return null;
    }

    return (
      <View className="m-4 min-h-64 flex-1 items-center justify-center rounded-3xl bg-m3-error-container p-4">
        <AppText
          role="titleMediumEmphasized"
          className="text-center text-m3-on-error-container">
          {activeError?.message || 'Failed to load content'}
        </AppText>
        <AppText
          role="bodyMedium"
          className="mt-1 text-center text-m3-on-error-container">
          Pull to refresh and try again
        </AppText>
      </View>
    );
  }, [activeError, activeIsLoading, activeHasData]);

  // Early return for no providers
  if (!installedProviders || installedProviders.length === 0) {
    return <Tutorial />;
  }

  return (
    <QueryErrorBoundary>
      <GestureHandlerRootView style={{flex: 1}}>
        <StatusBarScrim visible={statusBarScrimVisible} />
        <SafeAreaView className="flex-1 bg-m3-background">
          <StatusBar style="light" />

          <ScrollView
            onScroll={handleScroll}
            scrollEventThrottle={16} // Optimize scroll performance
            showsVerticalScrollIndicator={false}
            className="bg-m3-background"
            refreshControl={
              <RefreshControl
                colors={[colors.primary]}
                tintColor={colors.primary}
                progressBackgroundColor={colors.surfaceContainer}
                refreshing={manualRefreshing}
                onRefresh={handleRefresh}
                enabled={isAtTop || manualRefreshing}
              />
            }>
            <HeroOptimized />

            <ContinueWatching />

            <CategoryBar
              options={categoryOptions}
              selectedId={selectedCategoryId}
              onSelect={setSelectedCategoryId}
            />

            <View className="relative z-20 pb-8">
              {selectedCategory
                ? categorySlider
                : isLoading
                  ? loadingSliders
                  : contentSliders}
              {errorComponent}
            </View>

            <View className="h-8" />
          </ScrollView>
        </SafeAreaView>
      </GestureHandlerRootView>
    </QueryErrorBoundary>
  );
};

export default React.memo(Home);
