import ReviewsScreen from './ReviewsScreen.js';

/** A product’s reviews, and writing one for something that was delivered. */
export default {
  name: 'reviews',
  screens: [
    { name: 'index', path: 'reviews/:slug', title: 'reviews.title', component: ReviewsScreen },
  ],
  nav: null,
  strings: {
    en: {
      'reviews.title': 'Reviews',
      'reviews.of': 'Reviews of {name}',
      'reviews.summary': '{average} out of 5 from {count} reviews',
      'reviews.none': 'No reviews yet.',
      'reviews.reply': 'The store replied: {text}',
      'reviews.write': 'Write a review',
      'reviews.rating': 'Your rating',
      'reviews.body': 'What did you think?',
      'reviews.addPhoto': 'Add photos',
      'reviews.removePhoto': 'Remove',
      'reviews.send': 'Send review',
      'reviews.thanks': 'Thank you. Your review shows once the store has checked it.',
    },
    hi: {
      'reviews.title': 'समीक्षाएँ',
      'reviews.of': '{name} की समीक्षाएँ',
      'reviews.summary': '{count} समीक्षाओं में 5 में से {average}',
      'reviews.none': 'अभी कोई समीक्षा नहीं।',
      'reviews.reply': 'स्टोर ने जवाब दिया: {text}',
      'reviews.write': 'समीक्षा लिखें',
      'reviews.rating': 'आपकी रेटिंग',
      'reviews.body': 'आपको कैसा लगा?',
      'reviews.addPhoto': 'फ़ोटो जोड़ें',
      'reviews.removePhoto': 'हटाएँ',
      'reviews.send': 'समीक्षा भेजें',
      'reviews.thanks': 'धन्यवाद। स्टोर की जाँच के बाद आपकी समीक्षा दिखेगी।',
    },
  },
};
