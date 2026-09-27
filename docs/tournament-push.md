# Tournament setup and Web Push

Administrators can preview an official `/tournaments/eventSchedule/<id>` link, choose events, and prepare them together. The timezone belongs to the venue. Event links, rosters and round links must be observed on the official pages. Existing event IDs, source links and roster identities are reconciled under the configuration advisory lock. Pending events are revisited by manual controls and, when FTL_AUTO_SYNC=true, the server scheduler.

Apply only `prisma/migrations/20260927120000_bulk_setup_web_push/migration.sql` to the existing deployment. It is additive and was validated on an isolated Neon branch. Do not run the legacy migration chain on production.

Web Push requires `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` on the backend. Keep the key pair stable: rotating it requires browsers to subscribe again. Never put the private key or subscription endpoints in frontend configuration, audit logs, or source control.

Each authenticated browser explicitly opts in and chooses tournament IDs and/or event IDs. A whole-tournament selection covers future events. Logout unsubscribes the current browser. Expired push endpoints are disabled; users can reset a stale device subscription and send themselves a test notification.

New imported matches create a durable PushEvent within the same transaction. A lightweight server worker processes this outbox every 30 seconds; it never calls FTL. It filters closed/final matches using the shared full-round timing rules, reserves grouped deliveries under locks, and rechecks eligibility immediately before sending. New event cursors avoid alerts for history or repeated imports. Retries reuse a stable notification tag and expire after 15 minutes. Delivery to the actual phone is subject to its network, permission and OS settings; provider acceptance is not a receipt acknowledgement.

The service worker only caches public offline assets, never authenticated responses or predictions. Notification URLs are same-origin, validated event links with match IDs; a new window protects unsaved entries in an existing view.

## Automatic official controls (2026-09-28)

Set FTL_AUTO_SYNC=true on an always-on Render instance. The in-process worker scans linked events every 30 seconds and claims each due event in Neon. Active events are checked two minutes after a successful run, the day before every 15 minutes, more distant dates daily. Errors back off to 30 minutes; warnings retry after five minutes. A verified final podium with no pending warnings stops that event. Actor 0 identifies the service in the audit trail. No AI or Codex automation is involved. The Free Render tier sleeps without inbound traffic and therefore cannot guarantee this service.

Manual and automatic runs use the same per-event lease, cooldown, importer and notification outbox. Men and women cannot block each other. Apply only the additive 20260928090000_ftl_sync_state migration; never legacy migrations.

A changed bracket is read twice before cancelling a previously unfinished, now absent pairing. Published results or pairs still present elsewhere in the same round require review instead. Cancelled records retain their IDs, participants and prediction values, use an archived sourceKey, award zero, and are excluded from active brackets and round timing. Their history remains visible as Annulé. New official pairs receive separate IDs. Other verified pairs continue importing even if one conflict remains.
