import 'react-native-gesture-handler';
import { registerRootComponent } from 'expo';
import * as Font from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import App from './App';

// Each weight is named by its file, so the app carries only the six it uses. The names are the ones in @bhava/theme.
const fonts = {
  Figtree_400Regular: require('@expo-google-fonts/figtree/400Regular/Figtree_400Regular.ttf'),
  Figtree_500Medium: require('@expo-google-fonts/figtree/500Medium/Figtree_500Medium.ttf'),
  Figtree_600SemiBold: require('@expo-google-fonts/figtree/600SemiBold/Figtree_600SemiBold.ttf'),
  Figtree_700Bold: require('@expo-google-fonts/figtree/700Bold/Figtree_700Bold.ttf'),
  Unbounded_600SemiBold: require('@expo-google-fonts/unbounded/600SemiBold/Unbounded_600SemiBold.ttf'),
  Unbounded_700Bold: require('@expo-google-fonts/unbounded/700Bold/Unbounded_700Bold.ttf'),
};

// The splash stays until the two typefaces are in; if they fail to load the app still opens, in the system font.
SplashScreen.preventAutoHideAsync().catch(() => {});
Font.loadAsync(fonts)
  .catch(() => {})
  .finally(() => SplashScreen.hideAsync().catch(() => {}));

registerRootComponent(App);
