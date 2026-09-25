import {BasicAlertDialog, Host, RNHostView} from '@expo/ui/jetpack-compose';
import React from 'react';
import {StyleSheet, View, ViewStyle} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import {useM3HostTheme} from '../../theme/M3PaletteContext';

const GLASS_RADIUS = 28;

interface MaterialDialogSurfaceProps {
  visible: boolean;
  children: React.ReactNode;
  dismissible?: boolean;
  onDismiss: () => void;
  style?: ViewStyle;
}

const MaterialDialogSurface = ({
  visible,
  children,
  dismissible = true,
  onDismiss,
  style,
}: MaterialDialogSurfaceProps) => {
  const hostTheme = useM3HostTheme();

  if (!visible) {
    return null;
  }

  return (
    <View
      pointerEvents="box-none"
      style={{left: 0, position: 'absolute', top: 0, zIndex: 1000}}>
      <Host matchContents {...hostTheme}>
        <BasicAlertDialog
          onDismissRequest={() => {
            if (dismissible) {
              onDismiss();
            }
          }}>
          <RNHostView matchContents>
            <View
              style={{
                // Native Compose hosts this dialog in its own window, so a
                // real backdrop blur behind it (as used for the tab bar)
                // wouldn't have anything to sample - approximate the same
                // glass language with a translucent tint, a soft top sheen,
                // and a hairline highlight border instead.
                backgroundColor: 'rgba(30,30,33,0.92)',
                borderColor: 'rgba(255,255,255,0.14)',
                borderRadius: GLASS_RADIUS,
                borderWidth: StyleSheet.hairlineWidth,
                maxWidth: 420,
                overflow: 'hidden',
                width: 340,
              }}>
              <LinearGradient
                colors={['rgba(255,255,255,0.10)', 'rgba(255,255,255,0)']}
                start={{x: 0, y: 0}}
                end={{x: 0, y: 0.4}}
                style={StyleSheet.absoluteFill}
                pointerEvents="none"
              />
              <View style={[{padding: 24}, style]}>{children}</View>
            </View>
          </RNHostView>
        </BasicAlertDialog>
      </Host>
    </View>
  );
};

export default MaterialDialogSurface;
