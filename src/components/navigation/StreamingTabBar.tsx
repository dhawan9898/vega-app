import type {BottomTabBarProps} from '@react-navigation/bottom-tabs';
import React from 'react';
import {TouchableOpacity, useWindowDimensions, View} from 'react-native';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {settingsStorage} from '../../lib/storage';
import {useM3Colors} from '../../theme/M3PaletteContext';
import AppText from '../ui/Text';
import TabBarBackgound from '../TabBarBackgound';
import {AnimatedTabIcon, type AnimatedTabIconName} from './AnimatedTabIcon';

const GLASS_RADIUS = 32;

const TAB_ICONS: Record<string, AnimatedTabIconName> = {
  HomeStack: 'home',
  SearchStack: 'search',
  WatchListStack: 'watchlist',
  DownloadsStack: 'download',
  SettingsStack: 'settings',
};

const StreamingTabBar = ({
  state,
  descriptors,
  navigation,
}: BottomTabBarProps) => {
  const colors = useM3Colors();
  const insets = useSafeAreaInsets();
  const {width: windowWidth, height: windowHeight} = useWindowDimensions();
  const isNavigationRail = Math.min(windowWidth, windowHeight) >= 600;
  const showLabels = settingsStorage.showTabBarLabels();
  const bottomBarPadding = Math.max(insets.bottom, 8);

  return (
    <View
      style={{
        height: isNavigationRail ? '100%' : undefined,
        // Float above content instead of sitting flush against the screen
        // edges - the floating, detached-from-the-edge shape is a core part
        // of the liquid-glass look, and it also gives Android's elevation
        // shadow room to render without the rounded-corner clip below
        // cutting it off.
        marginBottom: isNavigationRail ? insets.bottom + 10 : bottomBarPadding,
        marginLeft: isNavigationRail ? insets.left + 10 : 12,
        marginRight: isNavigationRail ? undefined : 12,
        marginTop: isNavigationRail ? insets.top + 10 : 0,
        width: isNavigationRail ? 84 : undefined,
      }}>
      <View
        style={{
          borderRadius: GLASS_RADIUS,
          elevation: 12,
          flex: isNavigationRail ? 1 : undefined,
          overflow: 'hidden',
          shadowColor: '#000',
          shadowOffset: {width: 0, height: 6},
          shadowOpacity: 0.35,
          shadowRadius: 16,
        }}>
        <TabBarBackgound borderRadius={GLASS_RADIUS} />
        <View
          style={{
            alignItems: isNavigationRail ? 'center' : undefined,
            flex: isNavigationRail ? 1 : undefined,
            flexDirection: isNavigationRail ? 'column' : 'row',
            gap: isNavigationRail ? 8 : undefined,
            height: isNavigationRail ? undefined : showLabels ? 66 : 50,
            paddingBottom: isNavigationRail ? Math.max(insets.bottom, 12) : 4,
            paddingHorizontal: isNavigationRail ? 0 : 4,
            paddingTop: isNavigationRail ? Math.max(insets.top, 16) : 4,
          }}>
          {state.routes.map((route, index) => {
            const descriptor = descriptors[route.key];
            const focused = state.index === index;
            const label =
              typeof descriptor.options.tabBarLabel === 'string'
                ? descriptor.options.tabBarLabel
                : typeof descriptor.options.title === 'string'
                  ? descriptor.options.title
                  : route.name;
            const icon = TAB_ICONS[route.name] ?? 'home';

            const onPress = () => {
              const event = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (!focused && !event.defaultPrevented) {
                if (settingsStorage.isHapticFeedbackEnabled()) {
                  ReactNativeHapticFeedback.trigger('effectTick', {
                    enableVibrateFallback: true,
                    ignoreAndroidSystemSettings: false,
                  });
                }
                navigation.navigate(route.name, route.params);
              }
            };

            return (
              <TouchableOpacity
                key={route.key}
                accessibilityRole="button"
                accessibilityState={focused ? {selected: true} : {}}
                accessibilityLabel={descriptor.options.tabBarAccessibilityLabel}
                activeOpacity={0.8}
                onLongPress={() =>
                  navigation.emit({type: 'tabLongPress', target: route.key})
                }
                onPress={onPress}
                style={{
                  alignItems: 'center',
                  flex: isNavigationRail ? undefined : 1,
                  height: isNavigationRail
                    ? showLabels
                      ? 72
                      : 56
                    : showLabels
                      ? 58
                      : 42,
                  justifyContent: 'center',
                  minWidth: 48,
                  width: isNavigationRail ? 88 : undefined,
                }}>
                <View
                  pointerEvents="none"
                  style={{
                    alignItems: 'center',
                    backgroundColor: focused
                      ? colors.secondaryContainer
                      : 'transparent',
                    borderRadius: 16,
                    height: 32,
                    justifyContent: 'center',
                    overflow: 'hidden',
                    width: 56,
                  }}>
                  <AnimatedTabIcon
                    name={icon}
                    active={focused}
                    color={
                      focused
                        ? colors.onSecondaryContainer
                        : colors.onSurfaceVariant
                    }
                    size={24}
                  />
                </View>
                {showLabels ? (
                  <AppText
                    role={focused ? 'labelMediumEmphasized' : 'labelMedium'}
                    numberOfLines={1}
                    style={{
                      color: focused
                        ? colors.onSurface
                        : colors.onSurfaceVariant,
                      marginTop: 4,
                      textAlign: 'center',
                    }}>
                    {label}
                  </AppText>
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    </View>
  );
};

export default StreamingTabBar;
