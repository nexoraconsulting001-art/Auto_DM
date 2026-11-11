/** The theme every component reads: the seller theme unless a ThemeProvider says otherwise (a shopper app's brand kit). */
import React, { createContext, useContext, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { sellerTheme } from '@bhava/theme';

const ThemeContext = createContext(sellerTheme);

export function ThemeProvider({ theme = sellerTheme, children }) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);

/** Styles made from the theme once per theme: `const styles = useStyles((t) => ({ box: { padding: t.space[4] } }))`. */
export function useStyles(make) {
  const theme = useTheme();
  return useMemo(() => StyleSheet.create(make(theme)), [theme]); // eslint-disable-line react-hooks/exhaustive-deps
}
