<!-- Written from docs/go-live/store/branded-app-template.json and DATA_COLLECTED in src/contracts/apps.js by node tools/review-pack/index.mjs --write. Edit the source, not this file. -->

# A seller's branded app: listing, data safety and privacy label

The same template for every business. `{{brand_name}}` is the business's own name (30 characters at most). Nothing here names the platform: buyers see the seller's brand only.

## Google Play (template)

### title (14 of 30)

```text
{{brand_name}}
```

### shortDescription (53 of 80)

```text
Shop {{brand_name}} and track your orders in the app.
```

**category:** SHOPPING

### fullDescription (883 of 4000)

```text
{{brand_name}} in your pocket. Browse the catalog, save favourites, pay securely and follow every order until it arrives.

Shop
- Browse products and collections, with photos and videos.
- Save items to your wishlist and come back to them.
- Pay with UPI, cards, netbanking or cash on delivery where the shop offers it.

Orders
- Track every order, from packed to delivered.
- Start a return or exchange, with a photo of the item.
- Leave a review with a photo.

Your account
- Sign in with a WhatsApp code, Google or Apple. There are no passwords.
- Keep your addresses, so checkout takes a few taps.
- Choose which notifications you get, and when.

Permissions
- The camera and photo library are used only when you add a photo for a return or a review.
- Notifications tell you about your orders; offers only if you choose them.

You can delete your account in the app at any time.
```

## App Store (template)

### name (14 of 30)

```text
{{brand_name}}
```

### subtitle (21 of 30)

```text
Shop and track orders
```

### promotionalText (48 of 170)

```text
Browse, pay and follow your orders in one place.
```

### keywords (53 of 100)

```text
shop,store,orders,cart,wishlist,track,returns,cod,upi
```

**primaryCategory:** Shopping

**secondaryCategory:** Lifestyle

### description (883 of 4000)

```text
{{brand_name}} in your pocket. Browse the catalog, save favourites, pay securely and follow every order until it arrives.

Shop
- Browse products and collections, with photos and videos.
- Save items to your wishlist and come back to them.
- Pay with UPI, cards, netbanking or cash on delivery where the shop offers it.

Orders
- Track every order, from packed to delivered.
- Start a return or exchange, with a photo of the item.
- Leave a review with a photo.

Your account
- Sign in with a WhatsApp code, Google or Apple. There are no passwords.
- Keep your addresses, so checkout takes a few taps.
- Choose which notifications you get, and when.

Permissions
- The camera and photo library are used only when you add a photo for a return or a review.
- Notifications tell you about your orders; offers only if you choose them.

You can delete your account in the app at any time.
```

Limits are checked with a 30 character name filled in.

## Permission sentences

| Permission | Sentence shown to the person |
| --- | --- |
| android.permission.CAMERA | Take a photo of an item for a return request or a review. |
| android.permission.POST_NOTIFICATIONS | Notifications tell you about your orders; offers only if you choose them. |
| NSCameraUsageDescription | Take a photo of an item for a return request or a review. |
| NSPhotoLibraryUsageDescription | Choose a photo or a short video of an item for a return request or a review. |

## Data safety (Google Play) and privacy label (Apple)

No tracking. Nothing is shared with a third party for its own use. Deletion of the account is in the app.

| Data | Play category and type | Apple category and type | Required | Purposes | Linked to the person |
| --- | --- | --- | --- | --- | --- |
| name | Personal info: Name | Contact Info: Name | optional | App functionality | yes |
| phone | Personal info: Phone number | Contact Info: Phone Number | required | App functionality | yes |
| email | Personal info: Email address | Contact Info: Email Address | optional | App functionality | yes |
| address | Personal info: Address | Contact Info: Physical Address | required | App functionality | yes |
| purchase_history | Financial info: Purchase history | Purchases: Purchase History | required | App functionality | yes |
| device_id | Device or other IDs: Device or other IDs | Identifiers: Device ID | required | App functionality | yes |

## Age rating

- Google Play: Everyone, unless the business sells age-restricted goods; the questionnaire answers are in age-rating.md.
- App Store: 4+ unless the business sells age-restricted goods.

## Review notes

```text
The app opens on the shop {{brand_name}}. Use the review sign-in: in the app's sign-in screen enter the review phone number and code given in the credentials fields. The demo account has sample orders and a saved address. No payment is taken: the review build uses the payment gateway's test mode, and cash on delivery needs no payment. Notifications can be allowed or refused; the app works either way. Delete the account from the account screen.
```
