# Store review playbooks

One file per playbook in PLAYBOOKS (src/contracts/apps.js), named by its code. A rejection is matched to its playbook by its
guideline: exactly, then without its bracket (5.1.1(v) to 5.1.1), then by its parents (4.2.3 to 4.2); anything else is
`unknown`. The console shows the playbook with the rejection, and the owner sees its title.

Before any build goes to review, the pre-submit gate (`node tools/presubmit/index.mjs`) checks what most of these playbooks fix.
