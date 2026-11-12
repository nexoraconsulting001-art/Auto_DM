import Globe from 'lucide-react-native/icons/globe';
import { staffWith } from '@bhava/app-core/access';
import DomainsScreen from './DomainsScreen.js';

/**
 * Domains (PRD 5.4): the business's own web addresses. The screen's access is the list's (domains.list, staff with the
 * catalog permission); every change on it is the owner's, shown only to the owner and refused by the server for anyone
 * else. The plan must include custom domains.
 */
export default {
  name: 'domains',
  access: staffWith('catalog'),
  feature: 'custom_domain',
  routeIds: ['domains.list', 'domains.add', 'domains.setPrimary', 'domains.check', 'domains.remove'],
  screens: [{ name: 'index', path: 'domains', title: 'domains.title', component: DomainsScreen }],
  nav: { label: 'domains.title', order: 75, icon: Globe },
  strings: {
    en: {
      'domains.title': 'Domains',
      'domains.intro': 'Use your own web address for your store. Add the records below where you bought the domain, then check it.',
      'domains.records': 'Add these records at your domain provider',
      'domains.recordName': 'Name',
      'domains.recordValue': 'Value',
      'domains.primary': 'Main address',
      'domains.status.pending': 'Waiting for records',
      'domains.status.verified': 'Working',
      'domains.status.failed': 'Check failed',
      'domains.status.stopped': 'Stopped',
      'domains.checked': 'Checked {when}',
      'domains.check': 'Check now',
      'domains.makePrimary': 'Make main address',
      'domains.remove': 'Remove',
      'domains.removeTitle': 'Remove {domain}?',
      'domains.removeBody': 'Your store stops opening at this address. Links already sent with it stop working.',
      'domains.verified': '{domain} is working.',
      'domains.empty': 'No domains yet',
      'domains.emptyBody': 'The owner can add the business’s own web address here.',
      'domains.emptyOwner': 'Add your own web address below.',
      'domains.addTitle': 'Add a domain',
      'domains.addLabel': 'Domain',
      'domains.add': 'Add domain',
      'domains.invalid': 'Enter a domain such as shop.example.com, with no https:// or page.',
      'domains.ownerOnly': 'Only the owner can add or change domains.',
    },
    hi: {
      'domains.title': 'डोमेन',
      'domains.intro': 'अपनी दुकान के लिए अपना वेब पता इस्तेमाल करें। जहाँ से डोमेन ख़रीदा है, वहाँ नीचे के रिकॉर्ड जोड़ें, फिर जाँचें।',
      'domains.records': 'ये रिकॉर्ड अपने डोमेन प्रोवाइडर पर जोड़ें',
      'domains.recordName': 'नाम',
      'domains.recordValue': 'वैल्यू',
      'domains.primary': 'मुख्य पता',
      'domains.status.pending': 'रिकॉर्ड का इंतज़ार',
      'domains.status.verified': 'चल रहा है',
      'domains.status.failed': 'जाँच फ़ेल',
      'domains.status.stopped': 'रुका हुआ',
      'domains.checked': '{when} जाँचा गया',
      'domains.check': 'अभी जाँचें',
      'domains.makePrimary': 'मुख्य पता बनाएँ',
      'domains.remove': 'हटाएँ',
      'domains.removeTitle': '{domain} हटाएँ?',
      'domains.removeBody': 'आपकी दुकान इस पते पर खुलना बंद हो जाएगी। इससे भेजे गए लिंक काम करना बंद कर देंगे।',
      'domains.verified': '{domain} चल रहा है।',
      'domains.empty': 'अभी कोई डोमेन नहीं',
      'domains.emptyBody': 'मालिक यहाँ बिज़नेस का अपना वेब पता जोड़ सकते हैं।',
      'domains.emptyOwner': 'नीचे अपना वेब पता जोड़ें।',
      'domains.addTitle': 'डोमेन जोड़ें',
      'domains.addLabel': 'डोमेन',
      'domains.add': 'डोमेन जोड़ें',
      'domains.invalid': 'shop.example.com जैसा डोमेन लिखें, बिना https:// या पेज के।',
      'domains.ownerOnly': 'डोमेन सिर्फ़ मालिक जोड़ या बदल सकते हैं।',
    },
  },
};
