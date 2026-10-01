# Veritas Bible Challenge

A mobile-friendly Bible competition app with participant accounts, a timed quiz, automatic scoring, an organizer dashboard, SQLite persistence, and optional Stripe Checkout.

## Requirements

- Node.js 20.19+ or 22.12+ (Node 24 is suitable)
- npm

## Run locally

1. Open this folder in VS Code.
2. In the integrated terminal, run **npm install**.
3. Copy **.env.example** to **.env** and replace JWT_SECRET with a random secret at least 32 characters long.
4. Set an organizer login using ADMIN_EMAIL and ADMIN_PASSWORD in .env. The admin account is created the first time the server starts. Use a strong, unique password.
5. Leave DEMO_MODE=true for exploration. Run **npm run dev**.
6. Open http://localhost:5173. Register a participant, visit Competition, and complete the demo entry. The app issues a unique access code after the demo payment action.

The sample competition is scheduled for October 18, 2026, 10:00–11:00 India time. Change the start and end under Admin dashboard → Competition setup to try the live quiz flow. Sample questions are seeded on the first server start.

## Stripe test mode setup

To use a real test checkout instead of the demo payment:

1. Create a Stripe account and switch to test mode.
2. Copy the test secret key into STRIPE_SECRET_KEY in .env.
3. Set DEMO_MODE=false.
4. Make the API reachable by Stripe using a local webhook forwarder, for example Stripe CLI: stripe listen --forward-to localhost:3001/api/payments/webhook.
5. Copy the webhook signing secret printed by Stripe CLI into STRIPE_WEBHOOK_SECRET.
6. Use Stripe's test card 4242 4242 4242 4242, a future expiry date, and any CVC when completing Checkout.

The app only issues an access code after a signed Stripe webhook confirms payment and the session ID, amount, and currency match the server's pending payment record. The success redirect alone does not grant access. The configured fee is interpreted as a whole currency amount and converted to the smallest unit for Checkout (for example, INR 250 becomes 25000 paise). This conversion assumes a two-decimal currency; confirm Stripe's supported currencies and account capabilities before selecting a currency other than INR.

Set APP_URL to your public HTTPS site URL for a deployed app. For local testing, use http://localhost:5173. Configure Stripe's webhook endpoint with the deployed API URL plus /api/payments/webhook.

## Email setup

Email delivery uses the Resend HTTP API. Set `RESEND_API_KEY` and `EMAIL_FROM` in the server's `.env`; verify the sender domain in Resend and use an address on that domain. `APP_URL` is included as the dashboard link in email templates. The app sends registration, payment/access-code, and submission emails. Every attempt is saved in `email_deliveries` with `pending`, `sent`, or `failed` status. Provider acceptance is recorded as `sent`; check Resend's dashboard for downstream delivery and bounce information.

If the Resend values are missing or the provider rejects a message, the participant flow still completes and the failure status is recorded. The participant dashboard shows payment email status. Admins can view registration, payment, and submission email statuses, then resend payment confirmation and access-code messages from Admin dashboard → Participants. Resending creates a new delivery record.

## Advanced competition features

- **Scoring:** Admins can set correct-answer points, wrong-answer deductions, and unanswered deductions (defaults: +1, −0.25, and 0). A question can override the correct-answer default with its own point value. Final scores are rounded to two decimal places and bounded to keep invalid values out of results and the leaderboard. The participant result is stored once; the admin result view includes each answer, outcome, and point change.
- **Categories and imports:** Questions have a category and Easy/Medium/Hard difficulty. Admins can create, rename, delete, and filter categories. Deleting a category moves its questions to General. The question bank accepts up to 1,000 entries, including CSV and `.xlsx` imports of up to 1,000 rows and 5 MB. The import checks required headers, options, correct answer, difficulty, points, duplicate prompts, and reports row-specific errors. Use the dashboard's sample CSV as the column guide.
- **Analytics:** The admin dashboard summarizes participant/submission counts, score range and average, completion time, paid/unpaid counts, difficulty and category accuracy, and the most correct, incorrect, and skipped questions.
- **Participant management:** Search by participant name, email, church, or district. Filter account/payment status, view profile and quiz breakdowns, resend payment/access-code emails, disable or enable an account, clear an attempt for a retake, or delete the local participant record. Destructive actions ask for confirmation. Deleting local records does not issue an external refund.
- **Languages:** The normal Veritas home page includes a prominent English/Kuki/Tamil competition-language section. Choosing a card creates a short-lived registration selection and opens registration; the choice is then stored permanently in `users.preferred_language` and `users.competition_language`. Participants may change the language from their profile until a successful payment/access code is issued. The payment and access-code rows each retain the competition ID and language; the code row also stores payment and used status. Starting the exam verifies code ownership, paid status, and live dates, then freezes the code language as `submissions.question_language`. `/api/questions` localizes prompts and options from that frozen value and falls back to English for missing translation cells. The client takes its language from the API response and does not expose an exam-time language switch. Interface strings are in `client/src/i18n.ts`; missing dictionary entries fall back to English (the Kuki dictionary currently has only its welcome string translated).
- **Security controls:** Admin APIs resolve the current account role from the database, disabled accounts lose API access, input is checked on the server, and registration/login/payment/import endpoints are rate-limited. CSV/XLSX files are parsed with size, row, archive-entry, and expanded-size caps; uploads are parsed in memory and are not saved to disk. Security events are recorded in `security_events`. API authentication uses a bearer token rather than cookies; configure HTTPS in deployment.

### Database and API changes

Startup migrations add participant `active`, short-code `preferred_language`, and permanent slug `competition_language` fields; question `category`, `difficulty`, scoring, and six multilingual columns (`english_question`, `kuki_question`, `tamil_question`, `english_options`, `kuki_options`, `tamil_options`); a short-lived `language_selections` table; submission order, timing, warning, answer timestamp, score-breakdown, and locked `question_language` fields; payment `competition_id` and `language` fields; access-code `competition_id`, `language`, `payment_status`, and `used_status` fields; and the `categories` and `security_events` tables. Existing English prompts/options are copied into the new English columns, existing Kuki/Tamil rows in the former translation table are migrated, and prior payments/codes are backfilled from their user and payment records. Existing rows are retained and old profiles default to English. Back up the database before deploying schema changes.

New/expanded API routes include `POST /api/language-selection`, `GET /api/admin/overview`, participant detail/status/reset/delete routes under `/api/admin/participants`, `POST /api/admin/participants/:id/resend-email`, `PUT /api/profile/language` (language changes are blocked after code issuance), category CRUD under `/api/admin/categories`, `PUT /api/admin/settings`, `POST /api/admin/questions` for multilingual question create/update, and `POST /api/admin/questions/import` for CSV/XLSX imports. Participant question requests use the language frozen into their submission at exam start; admin requests can still request a preview language. Competition routes continue to persist shuffled order, timing, answer saves, warnings, submission timestamps, and score breakdowns; question/answer access still requires a valid paid code.

#### Multilingual question CSV/XLSX format

The English prompt and four English options are required. Kuki and Tamil cells may be blank; a blank question or option falls back to its English equivalent. `correct_index` is zero-based (`0` = option A through `3` = option D), and it is shared by all languages, so keep translated options in the same order as English. Older templates with `Correct Answer` values A–D or 1–4 remain supported.

```csv
question_en,question_kuki,question_ta,option_a_en,option_a_kuki,option_a_ta,option_b_en,option_b_kuki,option_b_ta,option_c_en,option_c_kuki,option_c_ta,option_d_en,option_d_kuki,option_d_ta,correct_index,category,difficulty,points
```

The Admin dashboard's sample CSV downloads this header. CSV and `.xlsx` imports use the same column names. “Export all questions” downloads the question bank in the same multilingual CSV format; for rows with more than four choices, this format includes the first four choices (bulk import uses the four A–D columns).

#### Adding another language

Add a locale code and display label to `client/src/i18n.ts`, add the locale dictionary, and extend the `LocaleCode` / `supportedLanguages` validation in `server/index.ts`. Because this schema intentionally has explicit columns for English, Kuki, and Tamil, a future language needs a database migration adding its question and options columns, plus editor, CSV aliases/template, and export mappings. Extend the language selection endpoint and participant display labels as well. Keep option order identical across languages so the shared correct-answer index remains valid.

This feature set adds no environment variables. Keep the existing Stripe, Resend, `APP_URL`, and secret configuration described below. The current in-memory rate limits are per server process; a multi-instance deployment should use a shared rate-limit store.

## Environment variables

Copy `.env.example` to `.env` and configure values on the API server only:

- `JWT_SECRET`: random secret, at least 32 characters.
- `ADMIN_EMAIL` and `ADMIN_PASSWORD`: organizer login; the admin account is created at first startup.
- `DEMO_MODE`: `true` grants a demo payment on the participant's explicit entry action; `false` requires Stripe Checkout.
- `ENTRY_FEE` and `CURRENCY`: fee in whole currency units; these seed the settings table on its first creation. Later fee changes are made in Admin dashboard → Competition setup.
- `APP_URL`: public/browser origin used for Stripe return URLs, email links, and CORS.
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`: Stripe test or live credentials, required when demo mode is off.
- `RESEND_API_KEY` and `EMAIL_FROM`: Resend API key and verified sender, optional for local app use but required for delivery.
- `DATABASE_PATH`: optional SQLite file path; defaults to `./server/data/competition.db`.

Never put Stripe or Resend secrets in client code or expose them to participants. Existing SQLite databases are upgraded at server startup with missing profile/payment/quiz columns and the email delivery table. Existing payments receive a currency from the current settings when that field is first added; existing paid payments receive a `paid_at` value based on their original creation time.

## Manual feature checks

1. **Registration and profile:** Start with `DEMO_MODE=true`, create a participant with all required fields, then sign out and register the same email again using different letter casing; the second registration should be rejected. Try a phone number containing a space or punctuation and omit each of Church, District, and State in turn; validation should reject each attempt. Open My profile, edit the name/contact/community fields, save, refresh, and confirm the changes and original registration date remain.
2. **Admin profile/search:** Sign in with the configured admin account. In Admin dashboard → Participants, confirm the new profile columns, registration date, and email statuses appear. Search by name, email, church, and district.
3. **Demo payment and access code:** Complete the participant's demo entry. Confirm payment status is paid, a payment ID and timestamp are shown, and one access code appears on the participant dashboard. Refresh and confirm the same code remains. Confirm an unpaid account cannot start the competition or fetch questions; a paid account with an invalid code is also denied.
4. **Stripe payment and access gate:** For an end-to-end payment check, set `DEMO_MODE=false`, use Stripe test credentials, and run the Stripe CLI webhook forwarder described above. Start Checkout and verify the participant remains pending and has no competition access before Stripe's signed success webhook arrives. Pay with `4242 4242 4242 4242` and a future expiry. After webhook confirmation, confirm paid status, payment ID/timestamp, and a code appear. Replay the same success event and confirm the code does not change and is not duplicated. Use Stripe's test dashboard to issue a full refund and confirm the entry changes to refunded and competition access is revoked. A failed test payment should be recorded as failed.
5. **Email notifications and resends:** With a valid Resend API key and verified `EMAIL_FROM`, register a participant, complete payment, and submit a competition attempt; check the inbox for welcome, payment/access-code, and score/submission messages. Check delivery statuses in the participant dashboard/admin table. In Admin dashboard → Participants, use both resend buttons and confirm fresh email delivery records. To check failure reporting, temporarily use an invalid Resend key and repeat a notification; the app should record failed status without losing registration/payment/submission. Restore the valid key afterward.

6. **Scoring and categories:** In Admin dashboard → Competition setup, set values such as +2 correct, −0.5 wrong, and −0.25 unanswered. Add a question with a custom point value, then complete a short quiz with a correct answer, wrong answer, and unanswered question. Confirm the stored total and per-question breakdown reflect the rules and the leaderboard uses the final score. Restore desired rules afterward. In Categories, create and rename a category, filter the question bank, then delete a temporary category and confirm its questions move to General.
7. **Question import:** Download the sample CSV, add valid rows and rows with a bad answer/header/value, and import. Confirm valid rows are added, duplicates are rejected, and the summary identifies failed row numbers and reasons. Use `correct_index` values 0–3. Repeat with an `.xlsx` workbook using the same headers; also try an unsupported extension and a file over 5 MB and confirm they are rejected.
8. **Analytics and participant controls:** Submit a few attempts with varied answers and categories. Confirm score, completion-time, payment, difficulty, category, and most/least-question summaries update. Search by each supported participant field and use payment/account filters. Open a participant record, verify answer-level scoring and email history, reset an attempt and confirm a retake is possible, disable/enable an account and confirm disabled sign-in/API access is refused, then test email resend. Use a disposable account to verify deletion.
9. **Language flow:** Create three disposable participant accounts. On the normal home page, choose English for one, Kuki for the second, and Tamil for the third; each card should open registration, and the chosen language should appear on the form. Refresh during registration: the home page remains the first page, the selected card stays highlighted, and selecting it again returns to registration. Complete registration and check `users.preferred_language` (`en`/`kck`/`ta`) and `users.competition_language` (`english`/`kuki`/`tamil`). Before payment, change one participant's language from My Profile and confirm the profile and pending payment language update. Pay with demo mode and confirm payment/access-code records retain matching `competition_id` and `language`, payment status is paid, and used status starts false. Confirm the admin table shows each participant's language. Create translations in all three tabs, leave one translation cell blank to see the fallback warning, and verify the exam uses the correct question/options for each participant. Refresh after exam start and confirm order and language remain frozen; the returned `/api/questions` payload should include the frozen language. Confirm attempts to change profile language after code issuance are rejected. Test blank Kuki/Tamil prompt and option cells for English fallback. Download/export and re-import the canonical multilingual CSV, then verify results, leaderboard, and analytics after submissions in different languages. Check home, registration, profile, quiz, leaderboard, and admin tabs at 320/375/390 px, 768 px, and desktop.
10. **Security checks:** Send repeated invalid login/registration/import/payment requests to confirm rate limits return 429 with `Retry-After`. Try participant tokens against admin routes, invalid access codes against quiz/question routes, malformed profile and question payloads, a CSV with quoted commas/newlines, a malformed `.xlsx`, and question rows containing HTML text. Confirm the API rejects unauthorized or invalid data and rendered text is escaped. Verify signed Stripe webhooks are required and normal score changes only happen through a stored submission.
11. **Timed quiz, recovery, and integrity:** During an open event, start two participants and confirm their question sequences are independently shuffled and each sequence stays the same after refresh. Confirm a question advances after 15 seconds, the timer resets for the next question and turns red under five seconds, and the progress count/bar updates. Leave a question blank and verify it is stored as unanswered. Select answers, refresh, and confirm they return; disconnect and reconnect the browser network to check the local copy syncs. Switch tabs or minimize the window three times and confirm warnings appear and the quiz submits; also try copy/cut/paste, text selection, and right-click. Confirm finishing the last question and reaching the event end also submit and record a submission time.

To trigger submission-email testing, set a short competition window in Admin dashboard → Competition setup and complete the quiz during that window; the final question, warning limit, and competition end also submit an attempt automatically.

## Useful commands

- npm run dev: start Vite and the API with hot reload
- npm run build: typecheck and build the frontend
- npm start: start the API process (serve the generated frontend separately with a static web server)

## Security and current limits

Passwords are hashed with bcrypt, API sessions use signed short-lived JWTs, and question answer keys are never sent to participants. Admin routes require the admin role. SQLite lives under server/data/ and is excluded from Git. Stripe secrets and the JWT secret belong only in .env, never in source control.

This is an initial implementation, not a production deployment. Before real participant data or money is involved, deploy behind HTTPS, use a shared rate-limit store for multiple server instances, add account recovery and email verification, backups, operational monitoring, and privacy/retention policies, and review payment/webhook behavior end to end with your Stripe account. Do not use the example admin password or fallback JWT secret outside local demo mode. Test the exact schedule, fee/currency, Stripe test webhook, and participant experience on your deployment.

## Progressive web app

The site includes a standalone PWA manifest, Veritas app icons, an install button on the home, registration, and participant dashboard screens, and an app-shell service worker. The worker caches the app shell and same-origin static assets for offline loading. It deliberately bypasses `/api` requests, so participant profiles, payments, access codes, answer keys, and competition responses are not written to the service-worker cache. When the browser reports that the network is back, the app retries account/session recovery; the competition API remains the source of truth for the current attempt, randomized question order, saved answers, and server timer. Locally saved quiz answers remain available for recovery/sync.

### Test locally

1. Run `npm run build`.
2. In one terminal run `npm start` (API on port 3001).
3. In another terminal run `npx vite preview --host 127.0.0.1` and open `http://127.0.0.1:4173`. Preview proxies `/api` to the local API and serves the production build, so the production-only service worker is enabled. `localhost` is a secure context for local PWA installation; a phone connected over LAN needs an HTTPS development URL or deployed HTTPS site.
4. On the home page, registration form, and participant dashboard, confirm **Install Veritas App** appears. Accept installation and confirm it disappears while the site is in standalone mode. If the browser does not expose an install prompt, the button opens platform instructions.
5. In browser DevTools → Application, inspect Manifest, Service Workers, and Cache Storage. Confirm all requested icon sizes load, the worker is active, and the shell assets are cached. Open the site once while online, switch the browser offline, and reload: the app shell/offline screen should appear. Restore connectivity and confirm the app returns to the signed-in route/session.
6. With a paid participant during a live competition, open the attempt, save an answer, then refresh or close/reopen the installed app. Confirm the server restores the same language and question order, saved answers, and remaining server-controlled question time. With connectivity disabled, the offline screen should be shown; reconnect and confirm the attempt is recovered. Inspect Cache Storage and verify there are no `/api` response entries.

### Install on devices

- **Android (Chrome):** Open the deployed HTTPS site, tap **Install Veritas App** (or accept Chrome's install prompt), then choose **Install**. Launch Veritas from the home screen/app drawer.
- **iPhone/iPad (Safari):** Open the HTTPS site in Safari, tap **Share**, choose **Add to Home Screen**, then tap **Add**. iOS does not expose Chrome's install prompt event; the Veritas button displays these steps. Launch it from the home screen for standalone display.
- **Desktop Chrome/Edge:** Open the HTTPS site. Use **Install Veritas App** or the browser's install icon/menu and confirm **Install**. The installed app opens in its own window.

Production hosting must use HTTPS (except localhost) and serve the SPA, `/manifest.webmanifest`, `/sw.js`, and `/icons/*` from the same origin. Keep `/api` routed to the authenticated API server; the service worker bypasses that path entirely. Browser offline indicators cannot guarantee access to the server, so quiz submission/answer sync still requires connectivity and resumes through the existing API recovery path after reconnect.
