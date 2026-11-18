---
'@adonis-agora/agent': patch
'@adonis-agora/agent-dashboard': patch
---

Federated console: `GET <path>/governance/apps` now says how each other app is reached and who runs its actions (`mode: 'federated'`, `actions: 'app'`: approvals and price changes go to that app over its `controlPlane`). The App picker tags those apps **federated**, a note at the top of the page says where the picked app's data comes from and who acts on it, and the Approve / Reject and Save price buttons turn off, with the reason, for an app a server reports as read-only here (`actions: 'none'`). Syncs the console kit's `AppModeBadge` / `FederatedNotice`.
