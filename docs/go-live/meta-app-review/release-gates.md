# Release gates (PRD 4.15)

A business goes live only when every gate below passes. Each gate writes a line in the compliance log with its code.

| Code | What must be true |
| --- | --- |
| gate.access_level | Advanced Access is granted for the account. Under Standard Access only people with a role on the app work. |
| gate.scope_missing | The messages and comments permissions are granted. If not, the owner sees a Reconnect button. |
| gate.privacy_url | The privacy page answers at its public address. |
| gate.deletion_callback | The data deletion callback answers at its public address. |
| gate.passed | All of the above passed. |

If the insights permission is denied or later removed, automations may still go live in slow mode. Analytics and Reach Guard say "Permission needed", Account Health drops by 30, and the owner is asked to reconnect.

Permission names are re-checked at App Review, and each approval is logged in the Platform Console. A Graph API version that stops being served within 90 days blocks releases.

The go-live checklist in the Platform Console (`npm run golive`) shows the same gates as ready or missing, with who must act.
