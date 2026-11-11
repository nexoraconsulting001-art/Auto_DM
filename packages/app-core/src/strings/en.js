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

  'common.close': 'Close',
  'common.done': 'Done',
  'common.save': 'Save',
  'common.notNow': 'Not now',

  'error.title': 'That didn’t load',
  'error.body': 'Something went wrong on our side. Try again in a moment.',
  'error.network': 'We couldn’t reach the server. Check your connection and try again.',
  'error.forbidden': 'You don’t have access to this. Ask the owner of this business.',
  'error.notFound': 'This isn’t here any more.',
  'error.saveFailed': 'That wasn’t saved. Try again.',

  'lock.method.face': 'face unlock',
  'lock.method.fingerprint': 'your fingerprint',
  'lock.method.any': 'fingerprint or face unlock',
  'lock.unlockWith': 'Unlock with {method}',
  'lock.offer.title': 'Open {app} with {method}?',
  'lock.offer.body': 'Next time, unlock the app with {method} instead of waiting for a new code. You can turn this off in Your account.',
  'lock.offer.yes': 'Turn it on',
  'lock.offer.failed': 'That didn’t work, so it’s still off. You can turn it on later in Your account.',

  'reauth.title': 'Confirm it’s you',
  'reauth.body': 'This change needs a quick check that it’s really you.',
  'reauth.device': 'Use {method}',
  'reauth.sendCode': 'Send a code on WhatsApp',
  'reauth.sent': 'We sent a 6-digit code on WhatsApp.',
  'reauth.code': 'Code from WhatsApp',
  'reauth.verify': 'Confirm',
  'reauth.noPhone': 'There’s no WhatsApp number on your account to send a code to. Use {method}, or add a number in Your account.',
  'reauth.failed': 'That code didn’t work. Check it and try again.',
  'reauth.refused': 'This phone can’t confirm it any more. Use a code instead.',

  'signedOut.removed': 'You no longer have access to that business. Sign in again to continue.',
  'signedOut.account_deleted': 'Your account is set to be deleted. Signing in again before then cancels it.',

  'signIn.codeSent': 'We sent a 6-digit code on WhatsApp to {phone}.',
  'signIn.resend': 'Send the code again',
  'signIn.resendIn': 'Send again in {seconds} s',
  'signIn.noWhatsApp': 'No WhatsApp on this number? Use Google instead.',
  'signIn.useGoogle': 'Use Google instead',
  'signIn.useApple': 'Use Apple instead',
  'signIn.badPhone': 'Enter a mobile number with WhatsApp, such as 98765 43210.',

  'workspace.switch': 'Switch business. Now in {business}',
  'workspace.notifications': 'Notifications',
  'workspace.notificationsUnread': 'Notifications, {count} new',
  'role.owner': 'Owner',
  'role.manager': 'Manager',
  'role.staff': 'Staff',
  'accountType.seller': 'Seller',
  'accountType.creator': 'Creator',

  'push.channel': 'Alerts',

  'time.justNow': 'Just now',
  'time.minutes': '{count} min ago',
  'time.hours': '{count} h ago',
  'time.days': '{count} d ago',
};
