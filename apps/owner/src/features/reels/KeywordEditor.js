import React from 'react';
import { Pressable, View } from 'react-native';
import X from 'lucide-react-native/icons/x';
import { useStrings } from '@bhava/app-core';
import { Field, Text, useTheme } from '@bhava/ui';
import { addKeywords } from './form.js';

/**
 * Keywords as chips, and a box to type more (commas split them). Used by the reel store and the automation builder.
 * `labelKey`, `hintKey` and `removeKey` are string keys; `removeKey` fills {word}.
 */
export function KeywordEditor({ keywords, draft, onChange, onDraft, error, disabled = false, labelKey, hintKey, removeKey, testID = 'keywords' }) {
  const { t } = useStrings();
  const theme = useTheme();
  const commit = () => {
    if (!draft.trim()) return;
    onChange(addKeywords(keywords, draft));
    onDraft('');
  };
  return (
    <View style={{ gap: theme.space[2] }}>
      {keywords.length ? (
        <View testID={`${testID}-chips`} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
          {keywords.map((word) => (
            <View key={word} style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[1], paddingLeft: theme.space[3], borderRadius: theme.radius.pill, backgroundColor: theme.color.primaryTint }}>
              <Text variant="small" style={{ color: theme.color.primaryDeep }}>{word}</Text>
              <Pressable
                testID={`${testID}-remove-${word}`}
                accessibilityRole="button"
                accessibilityLabel={t(removeKey, { word })}
                disabled={disabled}
                onPress={() => onChange(keywords.filter((other) => other !== word))}
                style={{ minWidth: theme.tap.min, minHeight: theme.tap.min, alignItems: 'center', justifyContent: 'center' }}
              >
                <X size={16} color={theme.color.primaryDeep} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <Field
        testID={`${testID}-draft`}
        label={t(labelKey)}
        hint={hintKey ? t(hintKey) : undefined}
        value={draft}
        onChangeText={(text) => {
          if (text.includes(',')) {
            onChange(addKeywords(keywords, text));
            onDraft('');
          } else onDraft(text);
        }}
        onSubmitEditing={commit}
        onBlur={commit}
        maxLength={60}
        autoCapitalize="characters"
        autoCorrect={false}
        editable={!disabled}
        error={error}
        returnKeyType="done"
      />
    </View>
  );
}
