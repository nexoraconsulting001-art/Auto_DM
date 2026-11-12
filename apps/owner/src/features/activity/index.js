import MessageCircle from 'lucide-react-native/icons/message-circle';
import { staffWith } from '@bhava/app-core/access';
import ActivityScreen from './ActivityScreen.js';

/**
 * DM activity (the console's /activity): every comment the business received and what happened to it. The rows hold a
 * commenter's name and words, so they are drawn on this screen and nowhere else: never a log, never a notification.
 */
export default {
  name: 'activity',
  access: staffWith('automations'),
  feature: null,
  routeIds: ['activity.list', 'console:/activity'],
  screens: [{ name: 'index', path: 'activity', title: 'activity.title', component: ActivityScreen }],
  nav: { label: 'activity.title', order: 60, icon: MessageCircle },
  strings: {
    en: {
      'activity.title': 'DM activity',
      'activity.intro': 'Every comment we received, and what happened to it. Newest first.',
      'activity.empty': 'Nothing yet',
      'activity.emptyBody': 'Comment a reel’s keyword from another account and it will show up here.',
      'activity.someone': 'Instagram user',
      'activity.openReel': 'Opens this reel’s store',
      'activity.result.sent': 'DM sent',
      'activity.result.processing': 'Sending',
      'activity.result.error': 'Failed',
      'activity.result.skip:no-keyword': 'No keyword',
      'activity.result.skip:unmapped-reel': 'Reel not set up',
      'activity.result.skip:own-comment': 'Your own comment',
      'activity.result.skip:already-sent-to-user': 'Already sent',
      'activity.result.skip:duplicate-comment': 'Already handled',
      'activity.result.skip:malformed': 'Unreadable',
      'activity.result.skip:not-connected': 'Instagram not connected',
      'activity.result.skip:capped': 'Limit reached',
      'activity.result.skip:too-short': 'Too short',
    },
    hi: {
      'activity.title': 'DM गतिविधि',
      'activity.intro': 'हमें मिला हर कमेंट, और उसका क्या हुआ। सबसे नया पहले।',
      'activity.empty': 'अभी कुछ नहीं',
      'activity.emptyBody': 'किसी और अकाउंट से रील का कीवर्ड कमेंट करें, वह यहाँ दिखेगा।',
      'activity.someone': 'Instagram यूज़र',
      'activity.openReel': 'इस रील की दुकान खोलता है',
      'activity.result.sent': 'DM भेजा गया',
      'activity.result.processing': 'भेजा जा रहा है',
      'activity.result.error': 'नहीं गया',
      'activity.result.skip:no-keyword': 'कीवर्ड नहीं',
      'activity.result.skip:unmapped-reel': 'रील सेट नहीं',
      'activity.result.skip:own-comment': 'आपका अपना कमेंट',
      'activity.result.skip:already-sent-to-user': 'पहले ही भेजा',
      'activity.result.skip:duplicate-comment': 'पहले ही संभाला',
      'activity.result.skip:malformed': 'पढ़ा नहीं जा सका',
      'activity.result.skip:not-connected': 'Instagram जुड़ा नहीं',
      'activity.result.skip:capped': 'सीमा पूरी',
      'activity.result.skip:too-short': 'बहुत छोटा',
    },
  },
};
