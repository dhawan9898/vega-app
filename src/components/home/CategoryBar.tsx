import React, {useCallback} from 'react';
import {FlatList, Pressable} from 'react-native';
import AppText from '../ui/Text';
import {useM3Colors} from '../../theme/M3PaletteContext';
import {CategoryOption} from '../../lib/getHomepagedata';

export const FOR_YOU_CATEGORY_ID = '__for_you';

interface CategoryChipProps {
  label: string;
  selected: boolean;
  onPress: () => void;
}

const CategoryChip = React.memo(
  ({label, selected, onPress}: CategoryChipProps) => {
    const colors = useM3Colors();
    return (
      <Pressable
        onPress={onPress}
        style={({pressed}) => ({
          backgroundColor: selected
            ? colors.primary
            : pressed
              ? colors.surfaceContainerHighest
              : colors.surfaceContainerHigh,
          borderRadius: 20,
          paddingHorizontal: 16,
          paddingVertical: 8,
          marginRight: 8,
        })}>
        <AppText
          role="labelLarge"
          style={{color: selected ? colors.onPrimary : colors.onSurfaceVariant}}>
          {label}
        </AppText>
      </Pressable>
    );
  },
);

interface CategoryBarProps {
  options: CategoryOption[];
  selectedId: string;
  onSelect: (id: string) => void;
}

// Netflix-style horizontal chip bar - "For You" (the default aggregated
// feed) plus best-effort "Movies" / "TV Shows" and shared genre chips
// discovered across every installed provider.
const CategoryBar = ({options, selectedId, onSelect}: CategoryBarProps) => {
  const allOptions = React.useMemo<CategoryOption[]>(
    () => [{id: FOR_YOU_CATEGORY_ID, label: 'For You'}, ...options],
    [options],
  );

  const renderItem = useCallback(
    ({item}: {item: CategoryOption}) => (
      <CategoryChip
        label={item.label}
        selected={item.id === selectedId}
        onPress={() => onSelect(item.id)}
      />
    ),
    [selectedId, onSelect],
  );

  if (allOptions.length <= 1) {
    return null;
  }

  return (
    <FlatList
      data={allOptions}
      horizontal
      keyExtractor={item => item.id}
      renderItem={renderItem}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{paddingHorizontal: 16, paddingVertical: 12}}
    />
  );
};

export default React.memo(CategoryBar);
