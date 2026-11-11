/** Runs before each app test file: the storage every test may use, and nothing that would let a token leave SecureStore. */
jest.mock('expo-secure-store', () => require('./secure-store-mock.cjs'));
// The real provider draws nothing until the device reports its insets, which never happens in a test.
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
