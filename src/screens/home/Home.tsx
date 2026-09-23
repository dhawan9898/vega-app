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

type Props = NativeStackScreenProps<HomeStackParamList, 'Home'>;

const Home = ({}: Props) => {
  const colors = useM3Colors();
  const [statusBarScrimVisible, setStatusBarScrimVisible] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [isAtTop, setIsAtTop] = useState(true);

  const installedProviders = useContentStore(state => state.installedProviders);
  const setHero = useHeroStore(state => state.setHero);

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

  // Memoized error message - only show if there is no cached data and an error occurred
  const errorComponent = useMemo(() => {
    if (homeData.length > 0 || isLoading || !error) {
      return null;
    }

    return (
      <View className="m-4 min-h-64 flex-1 items-center justify-center rounded-3xl bg-m3-error-container p-4">
        <AppText
          role="titleMediumEmphasized"
          className="text-center text-m3-on-error-container">
          {error?.message || 'Failed to load content'}
        </AppText>
        <AppText
          role="bodyMedium"
          className="mt-1 text-center text-m3-on-error-container">
          Pull to refresh and try again
        </AppText>
      </View>
    );
  }, [error, isLoading, homeData.length]);

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

            <View className="relative z-20 pb-8">
              {isLoading ? loadingSliders : contentSliders}
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
