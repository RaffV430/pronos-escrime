# Tournament setup and Web Push

Administrators can preview an official `/tournaments/eventSchedule/<id>` link, choose events, and prepare them together. The timezone belongs to the venue. Event links, rosters and round links must be observed on the official pages. Existing event IDs, source links and roster identities are reconciled under the configuration advisory lock. Pending events are revisited only by the existing manual result control. This feature adds no FTL polling.

Apply only `prisma/migrations/20260927120000_bulk_setup_web_push/migration.sql` to the existing deployment. It is additive and was validated on an isolated Neon branch. Do not run the legacy migration chain on production.

Web Push requires `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` on the backend. Keep the key pair stable: rotating it requires browsers to subscribe again. Never put the private key or subscription endpoints in frontend configuration, audit logs, or source control.

Each authenticated browser explicitly opts in and chooses tournament IDs and/or event IDs. A whole-tournament selection covers future events. Logout unsubscribes the current browser. Expired push endpoints are disabled; users can reset a stale device subscription and send themselves a test notification.

New imported matches create a durable PushEvent within the same transaction. A lightweight server worker processes this outbox every 30 seconds; it never calls FTL. It filters closed/final matches using the shared full-round timing rules, reserves grouped deliveries under locks, and rechecks eligibility immediately before sending. New event cursors avoid alerts for history or repeated imports. Retries reuse a stable notification tag and expire after 15 minutes. Delivery to the actual phone is subject to its network, permission and OS settings; provider acceptance is not a receipt acknowledgement.

The service worker only caches public offline assets, never authenticated responses or predictions. Notification URLs are same-origin, validated event links with match IDs; a new window protects unsaved entries in an existing view.
