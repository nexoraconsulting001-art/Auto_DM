/**
 * The words the shared screens say, in English. Every key here has a line in hi.js (a test checks), and a screen
 * asks for a line by key with `t('offline.title')`, never writes one out. Words in {braces} are filled in.
 * Nothing here names the platform or a business: the app passes its own name.
 */
export default {
  'common.retry': 'Try again',
  'common.cancel': 'Cancel',
  'common.continue': 'Continue',
  'common.loading': 'Loading',
  'common.signOut': 'Sign out',

  'offline.banner': 'You’re offline. Showing what was saved on this phone.',
  'offline.title': 'No connection',
  'offline.body': 'Check your internet and try again. Anything you already opened is still here.',
  'offline.writeDisabled': 'Connect to the internet to make changes.',

  'update.title': 'Update required',
  'update.body': 'This version of {app} is too old to keep working. Update it to carry on.',
  'update.action': 'Get the update',

  'lock.title': 'Unlock {app}',
  'lock.prompt': 'Unlock {app}',
  'lock.action': 'Unlock',
  'lock.failed': 'That didn’t work. Try again, or sign in another way.',
  'lock.signInInstead': 'Sign in another way',

  'signedOut.expired': 'You were signed out. Sign in again to continue.',

  'push.denied': 'Notifications are turned off for {app} in your phone’s settings.',
  'push.unavailable': 'Notifications aren’t available on this phone.',
};
