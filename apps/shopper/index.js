import 'react-native-gesture-handler';
import { registerRootComponent } from 'expo';
import App from './App';

// A brand's own fonts are built into the binary by the expo-font plugin (app.config.js), so nothing is loaded here.
registerRootComponent(App);
