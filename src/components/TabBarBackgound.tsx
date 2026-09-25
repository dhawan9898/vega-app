import {StyleSheet, View} from 'react-native';
import React, {memo} from 'react';
import {BlurView} from 'expo-blur';
import LinearGradient from 'react-native-linear-gradient';

interface TabBarBackgoundProps {
  borderRadius: number;
}

// Liquid-glass style panel: real backdrop blur (so scrolling content behind
// the tab bar/rail actually shows through, frosted) plus a soft top-edge
// specular highlight and a faint tint for legibility. The app is dark-scheme
// only, so this doesn't need a light-mode variant.
const TabBarBackgound = memo(({borderRadius}: TabBarBackgoundProps) => {
  return (
    <View style={[StyleSheet.absoluteFill, {borderRadius, overflow: 'hidden'}]}>
      <BlurView
        intensity={55}
        tint="systemMaterialDark"
        style={StyleSheet.absoluteFill}
      />
      <View
        style={[
          StyleSheet.absoluteFill,
          {backgroundColor: 'rgba(18,18,20,0.38)'},
        ]}
      />
      <LinearGradient
        colors={['rgba(255,255,255,0.14)', 'rgba(255,255,255,0)']}
        start={{x: 0, y: 0}}
        end={{x: 0, y: 0.5}}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderColor: 'rgba(255,255,255,0.16)',
            borderRadius,
            borderWidth: StyleSheet.hairlineWidth,
          },
        ]}
      />
    </View>
  );
});

export default TabBarBackgound;
