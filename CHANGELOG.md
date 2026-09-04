# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [1.2.5] - 2026-09-04
### Changed
- Log SESSION_UPDATE at most once a minute per connection, and without its raw content preview — it fires every ~10s for an actively-splashing session and is always post-AUTH (never scanner-relevant), so logging every one at full detail was drowning out everything else once real traffic picked up.

## [1.2.4] - 2026-09-04
### Changed
- Log a redacted preview of each WS message's actual content (previously just its type/username), and log non-JSON messages at all instead of silently swallowing them — surfaces what a spoofed-User-Agent scanner is actually sending, not just that it connected. Tokens/passwords are always redacted before logging, and a connection is capped at 20 logged message bodies so a flooding client can't blow up log volume.

## [1.2.3] - 2026-09-04
### Changed
- Log a WS connection's User-Agent alongside its IP, and log SUBSCRIBE_CHAT's target community/channel instead of a bare "username=?" — makes it possible to tell what a connection actually is (plugin, chat viewer, or neither) straight from the logs.

## [1.2.2] - 2026-09-04
### Fixed
- Add a no-op `HELLO` WS message type so a frontend chat viewer with no community/channel selected yet (which legitimately sends nothing else) isn't mistaken for a silent scanner connection by the 1.2.1 timeout and disconnected.

## [1.2.1] - 2026-09-04
### Fixed
- Close WebSocket connections that never send a single app message (AUTH, SUBSCRIBE_CHAT, etc.) within 8 seconds of connecting — internet-wide scanners were completing the handshake and holding the socket open indefinitely doing nothing.

## [1.2.0] - 2026-09-02
### Added
- Log requests the API rejected outright (unmatched routes, malformed/oversized JSON bodies) as a structured JSON line on stdout, with method, path, client IP, and sanitized headers/body -- so exploit-scanner traffic shows up in Axiom (via Coolify's log drain) instead of silently 404ing with no trace. Caps how many lines a single IP can generate per minute so one aggressive scanner can't flood the logs.

## [1.1.4] - 2026-09-02
### Changed
- Move item-icon rendering out of the Docker image build and into a weekly GitHub Actions workflow that publishes a release asset — the build no longer needs a JDK/Gradle or a live OpenRS2 cache download, fixing deploys that failed or ran for hours when that step's BuildKit cache mount didn't survive between redeploys.

## [1.1.3] - 2026-08-31
### Fixed
- Add a WebSocket ping/pong heartbeat so connections silently killed by an idle reverse-proxy timeout are detected and closed cleanly, instead of sitting dead until the client's own reconnect logic eventually notices.

## [1.1.2] - 2026-08-31
### Fixed
- Stop dropping a migrated Friends Chat's messages whenever one doesn't carry a usable owner value — the chat relay now falls back to matching by the FC's current (self-healed) name instead of requiring an exact owner match on every single message.

## [1.1.1] - 2026-08-30
### Fixed
- Fix the server failing to start (`CannotCreateIndex`) because a Friends-Chat/Clan-Chat uniqueness index used a `$exists: false` filter that MongoDB rejects in partial indexes; it now uses an explicit synced flag instead, with a one-time migration to backfill it for existing communities.

## [1.1.0] - 2026-08-30
### Added
- Register a community's Friends Chat by its owner's RSN instead of its in-game name, and self-heal the stored name from live chat traffic — a Friends Chat can now be renamed at any time without breaking the chat relay's classification.

## [1.0.2] - 2026-08-18
### Changed
- Skip the Docker build's item-icon render step when OpenRS2's live game cache hasn't changed since the last build — a BuildKit-persisted build cache now reuses the previously-rendered icons instead of redownloading (~180MB) and re-rendering (~4000 icons) on every deploy.

## [1.0.1] - 2026-08-18
### Fixed
- Resolve the real client IP from Cloudflare's `CF-Connecting-IP` header instead of relying solely on `req.ip`, and updated `trust proxy` to account for Cloudflare as an added hop in front of nginx — so per-IP rate limiting and the chat relay's per-source block-list keep working correctly once traffic is proxied through Cloudflare.

Everything below [0.23.1] was reconstructed retroactively from the git log on 2026-08-15 — no
version was ever actually tagged or released for those entries. The numbers simulate what each
past commit would have bumped to had this file existed from the start (patch for fix/chore-ish
changes, minor for feat-shaped changes, per the version-bump convention below). Some patch
versions are skipped in this list on purpose: they were consumed by internal/chore-only commits
(doc-comment fixes, gitignore entries, marking a script executable, etc.) that do not warrant a
changelog line. [0.23.1] and every version after it are real.

## [Unreleased]

## [0.23.1] - 2026-08-15
### Added
- Add this retroactive CHANGELOG.md documenting the full project history.

## [0.23.0] - 2026-08-15
### Added
- Add an option to pin a dev-view fake session so the inactivity sweeper won't auto-clear it.

## [0.22.2] - 2026-08-14
### Fixed
- Recognize CLAN_GUEST_CHAT and CLAN_GIM_CHAT as clan chat in the chat relay.

## [0.22.0] - 2026-08-13
### Added
- Redesign !log/!pets output.
### Fixed
- Fix a status-icon regression in !log/!pets output.

## [0.21.0] - 2026-08-13
### Added
- Self-throttle outbound !log/!pets calls and support a RuneProfile API token.

## [0.20.1] - 2026-08-13
### Fixed
- Strip non-breaking spaces from the relayed sender name in the chat relay.

## [0.20.0] - 2026-08-13
### Added
- Resolve real item ids for !log/!pets server-side in the chat relay.

## [0.19.5] - 2026-08-13
### Changed
- Render item icons during the Docker build stage instead of committing them to git.

## [0.19.4] - 2026-08-13
### Fixed
- Render item icons at quantity 10000 to match RuneProfile's icons.

## [0.19.2] - 2026-08-13
### Fixed
- Extract the downloaded item-icon cache with extract-zip instead of the unzip CLI.

## [0.19.1] - 2026-08-13
### Changed
- Add tests for GET /items/:id/icon and wire the item-icon renderer into build/deploy.

## [0.19.0] - 2026-08-13
### Added
- Add a GET /items/:id/icon route.

## [0.18.0] - 2026-08-13
### Added
- Add a cache-based item icon renderer.

## [0.17.0] - 2026-08-13
### Added
- Correlate edited chat-command resends in place in the chat relay.

## [0.16.0] - 2026-08-12
### Added
- Add a minimum session length requirement for archiving, filtering out noise sessions.

## [0.15.0] - 2026-08-10
### Added
- Persist dev:local data across restarts, and add POST /dev/reset.

## [0.14.0] - 2026-08-09
### Added
- Add chatbox live-relay backend support: FC display names, split webhooks, and my-income.

## [0.13.0] - 2026-08-09
### Added
- Call the Ardy Host URL shortener when generating setup links.

## [0.12.3] - 2026-08-07
### Changed
- Allow the ardy.host URL.

## [0.12.2] - 2026-08-06
### Fixed
- Persist active-sessions embed message ids across restarts.

## [0.12.1] - 2026-08-06
### Fixed
- Fix an inaccurate player count.

## [0.12.0] - 2026-08-05
### Added
- Add support for the Discord bot.

## [0.11.0] - 2026-08-01
### Added
- Add community config options.

## [0.10.0] - 2026-07-31
### Added
- Add a community bank/income payout system and Discord account linking.

## [0.9.1] - 2026-07-31
### Changed
- Return applicationId from link-account so the bot can attach ticket buttons.

## [0.9.0] - 2026-07-31
### Added
- Add rank-based income tracking, community API tokens, applications, and a Discord bot backend.

## [0.8.0] - 2026-07-29
### Added
- Add a password reset feature.

## [0.7.0] - 2026-07-27
### Added
- Add a bulk splasher-assignment route for community admins; document LOCAL_DEV_ADMIN_USERNAME.

## [0.6.0] - 2026-07-27
### Added
- Add per-community and per-splasher Discord webhooks.

## [0.5.0] - 2026-07-27
### Added
- Add communities.

## [0.4.3] - 2026-07-23
### Fixed
- Deduplicate resumed session archives and throttle the active-sessions Discord embed.

## [0.4.2] - 2026-07-21
### Fixed
- Fix formatting issues and improve local webhook testing.

## [0.4.1] - 2026-07-13
### Fixed
- Fix session archiving: wrong timestamps and reconnect fragmentation.

## [0.4.0] - 2026-07-11
### Added
- Seed fake historical sessions and add a dev admin auto-login token.

## [0.3.0] - 2026-07-11
### Added
- Add dev-only tooling for injecting fake active sessions.

## [0.2.1] - 2026-07-10
### Changed
- Change route URLs and add CORS origin configuration.

## [0.2.0] - 2026-07-10
### Added
- Add the basic backend.

## [0.1.0] - 2026-04-03
### Added
- Initial project scaffold.
