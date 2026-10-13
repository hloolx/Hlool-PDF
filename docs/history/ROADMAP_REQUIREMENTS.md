# hlool pdf Roadmap Requirements Prompt

This document is a full product and engineering brief for another AI development agent. It is intentionally written in English so high-capability coding agents can parse it accurately. However, the implementation must remain fully compatible with Chinese users, Chinese UI copy, Chinese file names, UTF-8 data, CJK typography, and PDFs containing Chinese text or fonts.

## Copyable Prompt For A Development AI

You are a senior full-stack engineer maintaining the `hlool pdf` project. This project is a local-first, self-hostable PDF stamping workspace. The backend is Go. The frontend is React, TypeScript, and Vite. The product supports importing PDFs and images, importing stamp images, drag-and-drop stamping, seam seals, batch generation, page organization, user and guest accounts, an admin console, local storage, and S3-compatible storage.

Before implementing anything, read the existing code, README, product docs, design docs, and local configuration. Do not blindly rewrite the architecture. Do not break the current local workflow. Do not put third-party secrets into frontend code, frontend environment variables, browser storage, logs, tests, snapshots, or the repository. All third-party service calls that require secrets must be proxied through the backend. Secrets must live only in server-side configuration, encrypted database fields, or another explicitly server-side secret mechanism.

The generated code must be compatible with Chinese:

- Preserve UTF-8 everywhere.
- Support Chinese file names during upload, processing, storage, and download.
- Preserve Chinese PDF names in `Content-Disposition` headers.
- Keep Chinese UI text working; do not corrupt existing Chinese copy.
- Support CJK text rendering, wrapping, input, search, form validation, and error messages.
- Do not introduce assumptions that usernames, emails, file names, stamp aliases, invite labels, or PDF metadata are ASCII-only unless the product explicitly requires that specific field to be ASCII.
- When generating PDFs or images, avoid breaking Chinese glyphs, font fallback, page dimensions, or text encoding.

Build these capabilities in stages:

1. Add AI background removal for stamp images. The stamp import and stamp management flows should let users remove the background from an imported stamp image using the Gitee AI Serverless matting API, producing a transparent PNG. Users must be able to preview, confirm, undo, replace, or save the result as a new stamp.
2. Add a "make PDF look scanned" feature. Reference the local project `F:\code\pdf\lookscanned.io` for interaction patterns and scan-effect parameters. The goal is to generate PDFs that look like printed and scanned documents.
3. Systematically improve frontend responsive behavior, especially container overflow, admin console layout, tables, forms, sidebars, dialogs, button groups, and scroll regions across different viewport sizes and low-height windows.
4. Improve S3 and third-party provider configuration. Admins should be able to maintain providers, endpoints, tokens, model names, default response formats, enablement flags, and connection test results from the admin console. Configuration should be stored in the database with secret handling and frontend redaction.
5. Add a first-run installation and initialization wizard. On first launch, if the instance is not installed, show an install page where users can configure the database, administrator account, S3, AI services, email, OAuth providers, and initial runtime settings.
6. Support email login, email verification codes, Google/Gmail, GitHub, LinuxDo, and other login methods. All login methods must be configurable in the admin console.

Design and implement each requirement carefully. Prefer stable, secure, maintainable changes over flashy but fragile complexity.

## 1. Product Direction

The core value of `hlool pdf` is to make everyday PDF stamping fast, direct, private, and reliable. It should feel like a lightweight local desktop tool while also being deployable as a self-hosted service with accounts, permissions, object storage, and optional third-party integrations.

New features must preserve these principles:

- Local-first: base PDF stamping must work without third-party services.
- Privacy-first: source PDFs should not be stored long-term.
- Backend-proxied secrets: AI, email, OAuth, S3, and similar integrations must be called from the backend when secrets are involved.
- Admin-maintainable: common deployment settings should not require editing environment variables and restarting forever.
- Installer-friendly: first launch should guide non-developers through safe setup.
- Chinese-compatible: all features must work with Chinese UI, file names, aliases, PDF names, and CJK content.

## 2. AI Stamp Background Removal

### Background

Many stamp images have white, light, scanned, or photographed backgrounds. The existing frontend has some white-background transparency handling, but it is not enough for complex backgrounds. Add an "AI background removal" or "smart matting" action that separates the stamp foreground from the background and produces a transparent PNG.

### API Reference

Use the Gitee AI OpenAPI documentation:

- Docs entry: https://ai.gitee.com/docs/openapi/v1
- Matting endpoint anchor: https://ai.gitee.com/docs/openapi/v1#tag/%E5%9B%BE%E5%83%8F%E7%94%9F%E6%88%90/post/images/mattings

The requirement description says the API is a Serverless segmentation service that requires Access Token authorization and a `multipart/form-data` body:

- `model`: required. Use `RMBG-2.0` by default. The model name is case-insensitive and may support namespaced values such as `briaai/RMBG-2.0`.
- `image`: required. The input image can be either a remote image URL string or a locally uploaded binary file. These options are mutually exclusive.
- `response_format`: optional. Use `b64_json` by default instead of `url`, so the app does not need an extra remote download to fetch the processed stamp.

### Frontend UX

Add an AI background removal entry point in stamp import and stamp management:

- After importing a stamp image, keep the existing local white-background transparency handling.
- Add a button such as "AI background removal" or "Smart cutout" in the import confirmation or stamp detail flow.
- While processing, show a loading state and disable duplicate actions.
- After success, show a before/after preview: original image and transparent-background result.
- Let the user choose:
  - Use result and replace the current stamp.
  - Keep original.
  - Save result as a new stamp.
- The result should be stored as PNG with alpha.
- Handle failures clearly: provider not configured, invalid token, unavailable model, oversized file, timeout, malformed response, network failure, and permission denial.
- Do not silently overwrite the original stamp. Require confirmation or keep an undo path.

### Backend API

Add a backend-proxied API. Possible shapes:

- `POST /api/ai/matting/preview`: accept an uploaded image or `stampId`, return the processed PNG without saving.
- `POST /api/stamps/{id}/matting`: create and save a matting result for an existing stamp.
- `POST /api/stamps/matting`: a combined endpoint if that fits the existing code better.

Requirements:

- The Access Token must never appear in frontend bundles, local storage, browser network responses, or console logs.
- Read provider configuration from admin-managed server-side settings.
- Use `response_format=b64_json` by default.
- Validate input type, file size, and image dimensions.
- Use explicit timeouts, such as 30 seconds.
- Convert third-party errors into readable user-facing errors without leaking tokens, local paths, or raw sensitive responses.
- Record safe audit logs: time, user ID, provider, model, success/failure, and latency. Do not log image contents or tokens.

### Acceptance Criteria

- If no AI provider is configured, the UI clearly explains that admin configuration is required.
- With a valid Gitee AI token, a user can process PNG or JPEG stamp images.
- The output is a transparent PNG.
- The original image is not silently destroyed.
- The token is not visible in browser responses, frontend source, or console logs.
- Success, failure, timeout, permission, and missing-configuration cases are tested or manually verified.

## 3. PDF "Look Scanned" Feature

### Background

Some workflows need an electronic PDF to look like a printed and scanned document. This is similar to `lookscanned.io`: pages can be slightly rotated, noisy, blurred, brighter or darker, more contrasted, slightly yellowed, bordered, or converted to grayscale. Add this capability to `hlool pdf` while preserving the existing PDF stamping workflow.

Local reference project:

- `F:\code\pdf\lookscanned.io`
- It is a pure frontend implementation.
- Important scan parameters include `rotate`, `rotate_var`, `colorspace`, `blur`, `noise`, `border`, `scale`, `brightness`, `yellowish`, `contrast`, and `output_format`.
- Use it as a reference for UX, parameter ranges, preview behavior, worker usage, and offline processing. Do not blindly copy code. Rebuild the feature in the current React/Go architecture.

### Product Entry Point

Add a "Scanned look" or "Scan effect" feature:

- It can live near the generation controls, in the document panel, or in a dedicated inspector section.
- It must be enableable per PDF project.
- Batch generation should optionally apply the current scan settings to all files.
- Page organization output should still be eligible for scan effect processing.
- Export must create a new PDF and must not mutate the original file.

### Frontend UX

Provide:

- Current-page preview, ideally near real time.
- Before/after comparison, either side-by-side or toggle-based.
- Built-in presets:
  - Light scan.
  - Office copy.
  - Aged paper.
  - Black-and-white scan.
  - Custom.
- Controls:
  - Rotation angle.
  - Rotation variance.
  - Noise.
  - Blur.
  - Brightness.
  - Contrast.
  - Yellow paper tint.
  - Grayscale/color mode.
  - Border or page shadow.
  - Resolution or scale.
  - Output format, preferably PNG for quality and optionally JPEG for smaller files.
- States:
  - Waiting for preview.
  - Rendering current page.
  - Generating all pages.
  - Cancelled.
  - Failed with retry.

### Technical Direction

Prefer frontend-local processing for the first version because this feature can be fully browser-side and fits the privacy model:

1. Render PDF pages to canvas or image using the existing PDF.js pipeline.
2. Apply scan effects to each page image inside a Web Worker.
3. Rebuild a new PDF from processed page images.
4. Support cancellation, progress, bounded concurrency, and memory control.

Key concerns:

- Preserve PDF page size, orientation, and CropBox/MediaBox semantics as much as practical.
- Output pages should match the original dimensions unless the user explicitly changes scale.
- Do not let multi-page PDFs grow memory without limits.
- Worker failures, render failures, and cancellation must restore the UI cleanly.
- The generated PDF should be importable back into the workspace or downloadable as final output.
- Chinese file names, Chinese PDF metadata, and CJK-rendered page content must survive the workflow as well as the rasterization approach allows.

### Relationship To Stamping

Define processing order clearly:

- Default recommendation: page organization and stamping first, then apply the scan effect during final export. This makes stamps look scanned too.
- A "scan first, stamp later" mode can be considered later, but it is not required for the first version.
- The UI must clearly state that the scan effect applies to final output, not the original PDF.
- Batch generation must apply settings independently per file.

### Saved Presets

Scan settings should be saveable:

- Built-in presets are provided by the system.
- Users can save custom presets.
- Admins may configure a default preset later, but users can override their own preference.

Suggested configuration shape:

```json
{
  "enabled": true,
  "preset": "office-copy",
  "rotate": 0.6,
  "rotateVariance": 0.3,
  "colorspace": "sRGB",
  "blur": 0.25,
  "noise": 0.12,
  "border": true,
  "scale": 1.5,
  "brightness": 1.02,
  "yellowish": 0.08,
  "contrast": 1.05,
  "outputFormat": "image/png"
}
```

### Acceptance Criteria

- Users can enable scan effect for an imported PDF and preview the current page.
- Users can generate a new scanned-looking PDF.
- Page order, dimensions, and orientation are correct.
- Noise, blur, brightness, contrast, rotation, and color mode are adjustable at a basic level.
- Multi-page PDFs show progress and can be cancelled.
- Processing does not block the main UI.
- Source PDFs are not uploaded to third-party services by default.
- The existing stamping generation workflow is not broken.
- The scan settings panel works across key responsive viewports.

## 4. Responsive Frontend And Container Fixes

### Problem Areas

The main workspace and admin console may still have issues across viewport sizes:

- Unstable height calculations.
- Admin tables overflowing on narrow screens.
- Top bar button groups crowding or overlapping.
- Sidebars, inspectors, and dialogs scrolling poorly in low-height windows.
- Form controls, button text, and icons misaligning at smaller sizes.
- The admin console lacking a good narrow-window navigation strategy.

### Design Principles

- Do not build a marketing page.
- Keep the workspace focused on actual work: import, drag, stamp, organize, generate.
- The admin console should feel like a compact operations console: quiet, dense, readable, and scannable.
- Avoid cards inside cards. Repeated items may be cards; page sections should be structured layouts.
- Narrow tables can become list rows, grouped panels, or scoped horizontal scroll regions, but core actions must remain usable.
- Fixed-format controls must have stable dimensions.
- Button text must not overflow. Use icons, wrapping, truncation, tooltips, or responsive variants where appropriate.
- Chinese UI text tends to have different line-breaking behavior than English; test with Chinese strings and avoid ASCII-only assumptions.

### Priority Screens

- `/` main workspace.
- Stamp import and stamp shelf.
- Import-choice dialog.
- Password-protected PDF dialog.
- Right inspector.
- Batch generation panel.
- Page organizer and thumbnails.
- `/admin` admin console.
- Login and registration screens.
- Future `/install` wizard.
- Future scan-effect settings panel.

### Responsive Viewports To Verify

At minimum:

- 1440 x 900
- 1280 x 720
- 1024 x 768
- 768 x 1024
- 390 x 844
- 360 x 740

Acceptance criteria:

- No unintended horizontal overflow, except intentional table scroll regions.
- Top bar controls do not overlap.
- Admin actions remain usable on narrow screens.
- Dialog content scrolls in low-height windows, while footer actions remain reachable.
- Text does not collide with icons or adjacent content.
- Verification screenshots or browser automation notes are kept.

## 5. Admin-Managed Third-Party And S3 Configuration

### Goal

Many settings currently come from environment variables. Keep environment support, but allow admins to manage common deployment settings from the admin console:

- S3, R2, MinIO, and B2 object storage.
- Gitee AI matting service.
- Email service.
- OAuth providers.
- Third-party API tokens, endpoints, model names, enablement flags, defaults, and test results.

Environment variables can remain initial values or locked overrides. Common settings should be persisted in the database after deployment.

### Suggested Configuration Model

Option A:

- `system_settings`
  - `key`
  - `value_json`
  - `secret_ref` or `encrypted_value`
  - `updated_at`
  - `updated_by`

Option B:

- `service_providers`
  - `id`
  - `kind`: `matting`, `mail`, `oauth`, `storage`
  - `name`
  - `enabled`
  - `base_url`
  - `model`
  - `public_config_json`
  - `secret_config_json_encrypted`
  - `created_at`
  - `updated_at`

Sensitive fields include:

- Access tokens.
- OAuth client secrets.
- SMTP passwords.
- S3 secret access keys.

Rules:

- Frontend reads must return only configured status, updated time, and masked hints such as `****abcd`.
- Logs must never print secrets.
- Updates may allow blank secret fields to mean "keep existing secret".
- Connection test responses must be sanitized.

### S3 Configuration

Admin console should support:

- Bucket.
- Region.
- Endpoint.
- Prefix.
- Force path style.
- SSE mode.
- Checksum mode.
- Access key and secret key, or explicit use of environment credential chain.

The current code uses the AWS standard credential chain and does not accept `HLOOL_*` secret variables for credentials. If database-stored S3 credentials are added, implement encryption and strict redaction. Do not return secrets to the frontend.

### Configuration Activation

Design which changes apply immediately and which require restart:

- AI, email, and OAuth provider settings should apply immediately.
- Storage backend switching is riskier. Require a passing connection test and clearly warn about migration or restart requirements.
- Do not automatically migrate production storage unless a dedicated migration workflow exists.

## 6. First-Run Install Wizard

### Goal

On first launch, guide the user through initialization instead of requiring many environment variables.

Enter install mode when one of these is true:

- The data directory has no install marker.
- `auth.db` does not exist.
- No admin account exists.
- The system settings table has no installed flag.

After installation, store `installed=true` and the application version.

### Suggested Flow

Path: `/install`

Steps:

1. Welcome and environment check.
   - Show data directory.
   - Show app version.
   - Check database write access.
   - Check installation status.

2. Database configuration.
   - Initially support SQLite.
   - Future PostgreSQL/MySQL can be reserved in the data model, but do not pretend they work before implementation.
   - SQLite mode can use the current data directory.

3. Create administrator.
   - Username.
   - Password.
   - Confirm password.
   - Password strength guidance.

4. Storage configuration.
   - Local storage by default.
   - Optional S3-compatible storage.
   - Test connection.

5. AI service configuration.
   - Provider: Gitee AI.
   - Base URL.
   - Access Token.
   - Matting model: default `RMBG-2.0`.
   - Response format: default `b64_json`.
   - Test action.

6. Email configuration.
   - SMTP host and port.
   - Username.
   - Password.
   - From name and address.
   - TLS or STARTTLS.
   - Test verification email.

7. Login method configuration.
   - Email code login.
   - Username/password login.
   - GitHub OAuth.
   - Google/Gmail OAuth.
   - LinuxDo OAuth.

8. Finish installation.
   - Persist configuration.
   - Create admin.
   - Mark installed.
   - Redirect to login or workspace.

### Security Requirements

- `/install` is only available before installation completes.
- After installation, `/install` must redirect, return 403, or return 404.
- If an admin already exists, the installer must not reset admin credentials.
- For remote deployments, prevent unauthenticated public initialization. Use localhost-only access, a one-time setup token, or a setup URL printed to server logs.
- Passwords and tokens must only be submitted to the backend and must not be stored in browser storage.

## 7. Email Login And Verification Codes

### Goal

Support email as an identity and allow users to log in or register with a verification code.

### Flow

1. User enters email.
2. User requests a verification code.
3. Backend generates a 6- or 8-digit code with an expiration time, such as 10 minutes.
4. Email is sent.
5. User submits the code.
6. If the email belongs to an account, log in.
7. If it does not, follow admin policy for automatic registration.

Account binding:

- Existing password accounts can bind an email.
- Binding requires verification.
- Email must be unique.

Security:

- Store only a hash of the code, never plaintext.
- Codes expire and have attempt limits.
- Rate limit by IP, email, and user where applicable.
- Avoid revealing whether an email exists, except in admin-only surfaces.
- Email templates should contain only short codes or one-time links, never secrets.

### Admin Settings

Admins can configure:

- Whether email login is enabled.
- Whether first email login can auto-register.
- Code lifetime.
- Send rate limits.
- SMTP settings.
- Email subject and sender display name.

### Suggested Data Model

- `user_identities`
  - `id`
  - `user_id`
  - `provider`: `password`, `email`, `github`, `google`, `linuxdo`
  - `subject`
  - `email`
  - `email_verified`
  - `created_at`
  - `updated_at`

- `email_verification_codes`
  - `id`
  - `email`
  - `code_hash`
  - `purpose`
  - `expires_at`
  - `attempts`
  - `consumed_at`
  - `created_ip_hash`
  - `created_at`

## 8. OAuth Login: Google/Gmail, GitHub, LinuxDo

### Goal

Support multiple external identity providers managed from the admin console.

Note: "Gmail login" should usually be implemented as Google OAuth or OIDC login, not by asking for a Gmail password.

### Provider Configuration

Each provider should support:

- Enabled state.
- Client ID.
- Client Secret.
- Authorization URL.
- Token URL.
- UserInfo URL.
- Scopes.
- Redirect URI.
- Auto-registration policy.
- Account-binding policy.

GitHub:

- Provider key: `github`.
- Suggested scopes: `read:user user:email`.

Google/Gmail:

- Provider key: `google`.
- Suggested scopes: `openid email profile`.

LinuxDo:

- Provider key: `linuxdo`.
- Confirm current OAuth/OIDC parameters before implementing.

### Flow

- Login page shows enabled providers.
- User clicks a provider.
- Backend creates and stores state.
- Provider redirects to callback.
- Backend validates state, exchanges code, and fetches user info.
- If identity is already bound, log in.
- If not bound but email matches an existing account, follow binding policy.
- If not bound and third-party registration is allowed, create account.
- If registration is disabled, show a clear message.

### Security

- Always use OAuth state for CSRF protection.
- For OIDC, validate ID token signature, issuer, audience, and expiration.
- Client Secret never reaches the frontend.
- Callback errors must not leak sensitive parameters.
- Users may unlink providers, but cannot remove their last usable login method.

## 9. Admin Console Improvement

Upgrade the admin console into a real operations surface while staying restrained.

Suggested information architecture:

- Overview.
  - Registration status.
  - Guest mode.
  - Email status.
  - AI matting status.
  - Storage status.

- Accounts and registration.
  - Registration toggle.
  - Invites.
  - Guest mode.
  - Third-party auto-registration.

- Login methods.
  - Password login.
  - Email code login.
  - GitHub.
  - Google/Gmail.
  - LinuxDo.

- AI services.
  - Gitee AI matting.
  - Model configuration.
  - Token status.
  - Test connection.

- Storage.
  - Local storage.
  - S3-compatible storage.
  - Test connection.

- Email.
  - SMTP settings.
  - Test send.
  - Email templates.

- System.
  - Version.
  - Data directory.
  - Installation status.
  - Security hints.

Do not put every setting into one very long page. Use tabs, side navigation, or section anchors. On mobile and narrow windows, navigation must collapse cleanly.

## 10. Backend Architecture Guidance

### Configuration Service

Add a central configuration layer:

- Reads environment defaults.
- Reads database configuration.
- Merges priorities.
- Redacts sensitive fields for frontend use.
- Validates configuration.
- Tests provider connections.

Suggested priority:

1. Locked environment overrides, for example `HLOOL_CONFIG_LOCKED=1`.
2. Database configuration.
3. Environment defaults.
4. Code defaults.

### Provider Clients

Add interfaces such as:

- `MattingClient`.
- `MailSender`.
- `OAuthProvider`.
- `StorageConfigTester`.

This keeps implementation testable and makes future providers easier to add.

### Database Migration

If no formal migration system exists, add a simple one:

- Check `schema_migrations` at startup.
- Apply versioned SQL migrations in order.
- Stop startup on migration failure.
- Test upgrades from old databases.

### Audit Logs

Record:

- Admin configuration changes.
- Invite creation and disabling.
- Login success/failure summaries.
- Third-party identity bind/unbind events.
- AI matting success/failure summaries.

Never record:

- Passwords.
- Tokens.
- Verification codes in plaintext.
- Image contents.
- PDF contents.

## 11. Suggested Implementation Phases

### Phase 1: AI Stamp Matting MVP

- Add admin configuration for Gitee AI token and model.
- Implement `/api/ai/matting/preview`.
- Add frontend AI matting button and preview confirmation.
- Avoid overbuilding provider abstractions, but keep naming extensible.
- Verify no token leakage, readable errors, and saveable results.

### Phase 2: PDF Scan Effect MVP

- Reference `F:\code\pdf\lookscanned.io`.
- Add scan effect toggle, presets, and current-page preview.
- Use PDF.js plus Canvas/Web Worker for local processing.
- Generate a new PDF with scan effect.
- Verify multi-page progress, cancellation, memory behavior, and page dimension preservation.

### Phase 3: Admin Console Responsive Restructure

- Restructure admin information architecture.
- Fix containers, tables, forms, dialogs, and narrow layouts.
- Verify with browser screenshots across key viewports.

### Phase 4: Database-Backed System Configuration

- Add settings and provider tables.
- Manage AI, email, OAuth, and storage configuration.
- Add redaction, connection tests, and audit logs.

### Phase 5: Email Code Login

- Implement SMTP configuration.
- Implement code generation, hashing, sending, verification, and rate limits.
- Add email code login UI.
- Add admin email settings.

### Phase 6: OAuth Login

- Implement GitHub first, then Google/Gmail, then LinuxDo after confirming parameters.
- Add provider configuration, callback handling, binding, and auto-registration policy.
- Add admin controls.

### Phase 7: Install Wizard

- Define install state.
- Implement `/install` UI and backend initialization APIs.
- Support admin creation, local/S3 storage, AI, email, and OAuth initial configuration.
- Harden uninstalled-state security.

The install wizard may move earlier if deployment usability becomes more important than login method expansion.

## 12. Non-Goals

Do not build these in the short term:

- A full multi-tenant billing system.
- A complex role hierarchy beyond admin and regular user.
- Automatic production storage migration without a dedicated migration workflow.
- Frontend direct calls to Gitee AI or any secret-bearing third-party API.
- Mandatory database-backed configuration that makes simple local single-user usage painful.

## 13. Quality Requirements

After each phase:

- `go test ./...` passes.
- `npm --prefix web run build` passes.
- New backend APIs have unit or handler tests.
- Key frontend flows have manual verification notes; complex UI changes should have screenshots.
- README or deployment docs are updated.
- Admin UI never exposes secrets.
- Existing data directories continue to start smoothly.
- Chinese compatibility is checked where relevant: Chinese UI strings, Chinese file names, Chinese PDF names, and CJK PDF content.

## 14. Development Agent Working Rules

Before implementation, output:

- Which existing modules were read.
- Which phase should be done first and why.
- Which files are likely to change.
- Which database tables or migrations are needed.
- Security risks and rollback strategy.

During implementation:

- Work in small, reviewable steps.
- Preserve the existing product tone and UI style.
- Avoid heavy dependencies unless clearly justified.
- Do not mix install wizard, OAuth, S3 migration, AI matting, scan effect, and admin redesign into one untestable patch.

Final delivery must include:

- What was completed.
- What remains.
- Test commands and results.
- Manual verification paths.
- Whether the user must configure Gitee AI Access Token, SMTP, OAuth Client, or S3 credentials.
