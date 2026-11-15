# Showcase kit

What a showcase session needs, for the sample businesses of `seed/showcase`.

- `mehta-mart.md` and `plant-store.md`: one demo script per sample business, in numbered steps a presenter follows on a phone. Each says plainly which parts are simulated and why. Nothing in them needs a real Instagram account, real money or a deployed server.
- Each script is walked step by step in a browser on the seeded data by `e2e/p8/demo`, so a script that no longer matches the product fails. A route in backticks is opened; a control in backticks must still exist in the product.
- Feedback from a session is logged in the Platform Console, on the Feedback screen, against the business that gave it, and tracked to fixed.
- The seller console installs on a phone as a web app: see the install steps in the console at `/admin/settings/install`.

To add a business: add its seed file and its entry in `seed/showcase/manifest.json`, then copy one of the scripts and change the story. The structure is the same for every business.
