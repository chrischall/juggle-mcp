# Juggle (whyjuggle.com) — family-side API map

**Status: every endpoint, header and field below is DERIVED FROM THE SHIPPED JS
BUNDLE (deployedVersion v1.8.56, captured 2026-11-03) and is UNVERIFIED against
a signed-in account.** Nothing here has been called with real credentials. The
"Live verification checklist" at the end is the work list for the first
authenticated pass; until a row is ticked there, treat it as a hypothesis.

Sources: `app.js` (root `App`, async page-component map) and the lazily loaded
route chunks `js/<id>.js` (map in `app.js` `i.u=`). Chunk ids are cited so a
re-read after a deploy can diff the right file.

---

## 1. Architecture

- Laravel backend + Vue 2 front end. **Not a client-routed SPA**: every
  navigation is a full page load. The server renders
  `<App :server-data="{meta,user,data}">` (HTML-entity-encoded JSON) and the
  root component renders `<component :is="meta.page">` with
  `meta`, `user`, `data` as props.
- **XHR mode:** a page route requested with `X-Requested-With: XMLHttpRequest`
  + `Accept: application/json` answers the same `{meta, user, data}` as JSON
  (confirmed anonymously on public pages; the SPA itself relies on it — e.g.
  FindASitter re-queries `GET /sitters` and reads `response.data.data.sitters`,
  Messages polls `GET /messages` and reads `response.data.data.conversations`).
  **This is the read transport for the MCP: `getPage(path)` → `{meta,user,data}`.**
- `meta` keys seen (log-in page): `page`, `headerLinks`, `footerLinks`,
  `contentScrollable`, `condenseFooter`, `currYearCopyright`, `onLoadFlashMsgs`,
  `adminUrlParams`, `realUser`, `impersonatedUser`, `env`, `deployedVersion`,
  `csrfToken`, `publicImgBaseUrl`, `publicFilesBaseUrl`, `s3UploadsBaseUrl`,
  `serverError`, `googleClientId`.
- `user` fields read by components (null when signed out): `type`
  (`"family"` | `"sitter"`), `firstName`, `name`, `fullName`, `accountId`,
  `numUnreadMsgs`, `linkedToFb`, `passwordSet`, `appVersion`.
- **Three different ids per person** — do not mix them up:
  - `accountId` — used by favorites, reviews, accept/decline/remove sitter,
    request-sitter, `/bookings/create/{accountId}`.
  - `profileId` — used by the profile pages `/sitters/{profileId}`,
    `/sitters/{profileId}/schedule`, `/families/{profileId}`.
  - `userId` — used by messaging `/messages/users/{userId}`.
- Money is in **integer cents** throughout (`centsToDollarsAndCents` helper).
- Option lists (`data.lists.*`) are `[{id, name}]`.

## 2. Auth, CSRF and headers (chunk 2852 — shared axios instance)

### Login
1. `GET /log-in` → sets cookies `whyjuggle_session`, `XSRF-TOKEN`; HTML carries
   `<meta name="csrf-token" content="…">` (also `meta.csrfToken` in server-data).
2. `POST /log-in` JSON `{email, password}` with the headers below.
   - Response 200 `{"error": true}` → bad credentials (seen live, anonymously).
   - Success (bundle, chunk 2852 `LogIn.logIn`): `!data.error` → SPA does
     `location.assign(data.redirectUrl)`. So success is expected to be 200
     `{error: false|absent, redirectUrl: "/…"}` plus new `Set-Cookie`s.
   - No captcha in the email/password path (Google/Facebook flows are separate:
     `/log-in-with-google`, `/log-in-with-fb`, `/auth/link-google` — out of scope).
3. **Laravel regenerates the session + CSRF token on login.** The pre-login
   meta token is expected to be stale afterwards; re-read `meta.csrfToken` from
   any XHR page fetch (or rely on the rotated `XSRF-TOKEN` cookie — see below).

### Headers the SPA sends on every request
Set as axios defaults in chunk 2852:

| Header | Value | Notes |
|---|---|---|
| `X-CSRF-TOKEN` | `<meta name="csrf-token">` of the current page | fresh each full page load |
| `X-Requested-With` | `XMLHttpRequest` | also what flips page routes to JSON |
| `X-Client` | `Website` | |
| `Accept` | `application/json, text/plain, */*` | axios default |
| `X-XSRF-TOKEN` | URL-decoded `XSRF-TOKEN` cookie | axios default `xsrfCookieName`/`xsrfHeaderName`, sent same-origin |

- Request bodies are JSON (axios with a plain object).
- Every GET gets a cache-buster query param `timestamp=<ms>` (interceptor);
  presumably not required.
- `No-Loader: true` header on some calls only suppresses the UI spinner.
- **Recommendation for the client:** send `X-CSRF-TOKEN` (latest `meta.csrfToken`)
  AND `X-XSRF-TOKEN` (decoded cookie) on writes, plus `X-Requested-With`,
  `Accept: application/json`, `X-Client: Website`.

### Session expiry — how to detect
The SPA has **no global 401/419 interceptor** (full page loads mean the server
just redirects). Signals, from the bundle + Laravel convention:
- **401 / 419** — the upload helper (chunks 260, 7177, 8628, …) maps both to
  "Your session expired … Sign in again". 419 = CSRF/session mismatch.
- **302 → `/log-in`** for page routes when signed out (seen anonymously for HTML;
  XHR behaviour UNVERIFIED — may be 401 JSON or a redirect).
- **200 with `meta.page === "LogIn"`** (if the redirect is followed).
- **200 HTML** (login page) where JSON was expected.
- `/web-api/conversations` signed out → **401 JSON** (seen live).

Log out: `GET /log-out` (link in header).

## 3. Reads (family side)

All page routes are fetched with the XHR headers → `{meta, user, data}`.
`meta.page` is the Vue component name listed.

### 3.1 Home — `GET /` → `HomeFamily` (chunk 260) — UNVERIFIED
`data`: `hasProfilePhoto`, `alerts[]`, `announcements[]`.

### 3.2 My profile — `GET /my-profile` → `MyProfileFamily` (chunk 7177, form module 9323) — UNVERIFIED
`data`: `id`, `firstName`, `lastName`, `email`, `serviceAreaId`,
`profilePicImgUrl`, `referralCode`, `notes`, `isActive`, `hasSubscription`,
`addrs[]`, `kids[]`, `pets[]`, `friends[]` (`id, name, url, displayStatus`),
`profile` (snake_case: `partner_name`, `phone_num`, `emergency_contact_name`,
`emergency_contact_phone_num`, `house_instructions`, `neighborhood`, `school`,
`church`, `social_clubs`, `nanny_cam`, `can_be_friended`,
`profile_pic_img_name`), plus `serviceAreas`, `states`, `genders`, `petTypes`,
`yesNo` option lists.
Form field names (likely item keys): addrs `streetAddr, city, state, zipCode,
primary`; kids `name, gender, birthday/age, grade, school, allergies, foods,
hobbies, specialNeeds, dailyRoutines, otherInformation`; pets `name, type,
breed, age, feedingRoutine, outdoorRoutine, favoriteActivities,
specialInstructions`.
**Contains PII (address, phone, emergency contact) — compact view should omit.**
(`friends` = other FAMILIES the user is friends with, not favourite sitters.)

### 3.3 Bookings list — `GET /bookings` → `Bookings` (chunk 8288) — UNVERIFIED
`data`: `bookings[]`, `bookingStatuses` (options), `bookingStatusesMap`
(status → label), `bookingStatusColorsMap`, `bookingSorts`, `bookingSortsMap`,
`otherUserType` (`"Sitter"`/`"Family"`).
Booking item: `id`, `url`, `imgUrl`, `banner`, `status`, `type`,
`startDateTime` (sortable string), `startDateTimeFormatted`, `name` (other
party; `lastName` when other party is a family), `reoccurringBookingId`,
`reoccurringDotws`, `reoccurringUntilDate`, `numPendingApplications`,
`requestSentFromFamily` (`null|0|1`).
Filtering/sorting is **client-side**; the server returns all bookings. Status
values: `open`, `booked`, `in_progress`, `awaiting_confirmation`,
`awaiting_payment`, `awaiting_review`, `failed_payment`, `completed`,
`canceled`, `declined`, `expired`, `archived` (default UI filter = the first 7
active ones). → `juggle_list_bookings` can offer upcoming/active vs past by
status.

### 3.4 Booking detail — `GET /bookings/{bookingId}` → `BookingDetails` (chunk 6891) — UNVERIFIED
`data` (all read by the component): `bookingId`, `status`, `displayStatus`,
`serviceType`, `typeOfJob`, `startDate`, `startTime`, `endDate`, `endTime`,
`bookingDotw`, `flexibleEndDatetime`, `isReoccurring`, `reoccurringDotws`,
`reoccurringSeries[]` (`id, name, startDateFormatted, statusFormatted,
statusColor, numPendingApplications, requestSentFromFamily, status`),
`numKids`, `numPets`, `kidInfo`, `petInfo`, `numSitters`, `numBookedSitters`,
`numUnpaidHours`, `specialInstructions`, `includesTransportation`, `autopay`,
`emergencyBonusAmount`, `juggleEmergencyBonusAmount`, `postOnOpenJobs`,
`familyAccountId`, `familyUserId`, `familyLastName`, `familyAddrStr`,
`familyZipCode`, `primaryAddrStr`, `neighborhood`, `organization`, `phoneNum`,
`profileId`, `profilePicImgUrl`, `rating`, `banner`, `isFavorite`,
`familyPaymentAmount`, `familyPaymentBreakdown`, `sitterPaymentAmount`,
`sitterPaymentBreakdown`, `sitterHourlyRateAndTotal`, `bookingFeeAmount`,
`hasSubscription`, `subscriptionPlan`, `subscriptionYearlyPlan`,
`canCancelBooking`, `canConfirmPayment`, `canEdit`, `canSendMsg`,
`canStartBooking`, `canStopBooking`, `canApplyToBooking`, `hasReview`,
`sitterIdsWithBookingReviews[]`, `familyReviewRequiredTxt`,
`sitterReviewRequiredTxt`, `familyActualStartDatetime`,
`familyActualEndDatetime`, `sitterActualStart/EndDate/Time`,
`mustApplyToAllBookings`, `multipleJobsInTheSeriesCanBeAccepted`,
`conflictDetails`, `dateToday`, `userType`, `invalidBooking` (true → "booked
or canceled"), `recommendedRequests` (options for request-sitter),
`bookingRequestStatus` (sitter-side).
- `bookingSitters[]` (accepted): `id, accountId, profileId, userId, name,
  bookingId, rating, numJobsCompleted, isFavorite, sitterPhoneNum,
  sitterActualStartDate/Time, sitterActualEndDate/Time`.
- `bookingRequests[]` (applications/requests): `accountId, profileId, userId,
  name, rating, numJobsCompleted, isFavorite, requestSentFromFamily (0 =
  sitter applied, 1 = family requested), bookingRequestStatus ("pending" …),
  sitterApplicationRenewedAt, sitterHasPendingBookingRequestForAllOpenJobs`.
  UI groups: pending applications = `requestSentFromFamily===0 &&
  status==="pending"`; family requests = `===1 && pending`.
- Notes `specialInstructions`, `kidInfo`, `petInfo` are family-authored;
  sitter names/bios are third-party → untrusted.

### 3.5 Find sitters — `GET /sitters?…` → `FindASitter` (chunk 3902) — UNVERIFIED
Query params (all optional): `sittingDate` (YYYY-MM-DD), `sittingStartTime`,
`sittingEndTime` (HH:MM), `services[]`, `availableLongTermAsANannyValues[]`,
`infantCapableValues[]`, `keywords`, `certifications`, `name`, `numSitters`
(page size, UI starts at 20, +20 per "show more", UI caps at 200).
`data`: `sitters[]`, `totalNumSitters`, `filters` (echo of the above),
`services` and `yesNo` (option lists).
Sitter item: `id`, `url` (→ `/sitters/{profileId}`), `imgUrl`, `banner`,
`name`, `location`, `rating`, `numJobsCompleted`, `numFriends`, `isFavorite`,
`backgroundCheckCompleted`.
Profile links get `?sittingDateTimes=<date>|<start>|<end>` when filtered by date.

### 3.6 Sitter profile — `GET /sitters/{profileId}` → `SitterDetails` (chunk 7250) — UNVERIFIED
`data`: `accountId`, `userId`, `name`, `profilePicImgUrl`, `serviceAreaName`,
`momApprovedSince`, `numJobsCompleted`, `friendsThatHaveBooked[]` (`id, url,
imgUrl`), `hasCompletedBookings`, `isFavorite`, `backgroundCheckCompleted`,
`servicesOffered[]`, `childcareExperience[]`, `specialNeeds[]`,
`higherEducation[]`, `hasSubscription`, `canSendMsg`, `availableBookings`
(options for invite), `fromBooking`, `sittingDateTimes`, `bookingFeeAmount`,
`subscriptionPlan.amount`, `subscriptionYearlyPlan.amount`, `invalidSitter`,
and `profile` (snake_case: `id` (= profileId), `rating`, `certifications`,
`homework_subjects`, `pet_experience`, `available_long_term`, `bio`,
`hometown`, `hobbies_interests_extracurricular_activities_sports`,
`high_school`). `bio` etc. are sitter-authored → untrusted.
- `canSendMsg` false ⇒ messaging is gated behind a subscription (UI shows a
  subscription prompt). Same for "Invite Sitter to Apply".

### 3.7 Sitter schedule — `GET /sitters/{profileId}/schedule` → `SitterSchedule` (chunk 8582, module 1296) — UNVERIFIED
`data`: `id`, `sitterName`, `dotws`, `hours`, `dotwHours` (7×24 matrix of
date-hour keys), `selectedDateHours[]` (available), `bookedDateHours[]`,
`isThisWeek`, `previousWeekDate`, `nextWeekDate`.
Other weeks: `GET /sitters/{id}/schedule/go-to-week?date=YYYY-MM-DD` → returns
the availability object **directly** (not wrapped in `{meta,user,data}`).

### 3.8 Favorites — NO dedicated read endpoint found — UNVERIFIED
There is no favorites page/component in the bundle. Favourite status is an
`isFavorite` flag on sitter list items (3.5), sitter profiles (3.6) and booking
sitters/requests (3.4). `juggle_list_favorites` must therefore be derived:
`GET /sitters?numSitters=200` filtered on `isFavorite` (bounded by the
service-area sitter list), or a server-side filter discovered live.
(`recommendedRequests` on a booking "includes your favorites" — another hint.)

### 3.9 Reviews — `GET /reviews/{accountId}` → `Reviews` (chunk 1304) — UNVERIFIED
`data`: `reviewedName`, `reviews[]` (`id, date, name, rating, content, friend
(bool), imgUrl`). `content` is third-party text → untrusted.

### 3.10 Messages list — `GET /messages` → `Messages` (chunk 3583) — UNVERIFIED
`data.conversations[]`: `id`, `url` (server-built link to the conversation),
`name`, `imgUrl`, `lastMessage`, `numUnreadMsgs`, `messageCreatedAt`,
`conversationCreatedAt`, `is_archived`. The SPA polls this every 15 s.
`lastMessage`/`name` → untrusted.

`GET /web-api/conversations` (JSON API, not a page) → `{ data: [conversation…] }`
same item shape. Params: `include_archived=1` (bool), `search=<text>`.
Signed out → 401 JSON (seen live). Archive toggles:
`POST /web-api/conversations/{id}/archive` / `/unarchive` (body `{}`) — not in
the write scope. **No `/expand` endpoint exists in the bundle.**

### 3.11 Conversation — `GET <conversation.url>` or `GET /messages/users/{userId}` → `Conversation` (chunk 8628) — UNVERIFIED
`/messages/users/{userId}` is the "Send a Message" link from sitter profiles and
bookings — expected to open (or create) the 1:1 conversation. Exact
`conversation.url` pattern unknown (likely `/messages/{conversationId}`).
`data`: `conversationId`, `isActive` (false ⇒ own account deactivated, cannot
post), `messages[]` (`id, name, imgUrl, sentAt, myMessage (bool), type
("text"|"image"), content`). `content` → untrusted.
⚠ Opening `/messages/users/{userId}` may itself create a conversation — check
live before using it in a read tool.

### 3.12 Payments — `GET /payments` → `PaymentsFamily` (chunk 3235) — UNVERIFIED
`data`: `serviceAreaName`, `baseRates`, `surgePrices`, `paymentMethods[]`
(`id, card{brand,last4,exp_month,exp_year}`), `defaultPaymentMethodId`,
`hasSubscription`, `subscription` (`id, planId (1 monthly, 2 yearly), type,
currentPeriodEnd, endAt`), `subscriptionPlan.amount`,
`subscriptionYearlyPlan.amount`, `promoCodes[]` (`id, name, desc, type,
remainingAmt, expiresOn`), `transactions[]` (`id, type, total,
transactionDatetime, tipAmount, discountedAmount, subsidizedAmount,
subsidizedPct, bookingId, bookingStartDate/Time, bookingEndDate/Time,
sitterFullName`), `org`, `paymentManagementMode` (`"stripe_hosted"`…),
`openSections`, `publishableKey`, `intent` (Stripe SetupIntent — never return),
`stripe*` status flags.
JSON helpers (reads):
- `GET /payments/get-payment-method-info` → `{paymentMethods, defaultPaymentMethodId}`
- `GET /payments/get-subscription` → `{subscription}`
- `GET /payments/get-promo-codes` → `{promoCodes}`
- `GET /payments/export-transactions-to-csv` (CSV download link)
**Never surface `intent`/`publishableKey`/client secrets.**

### 3.13 Notifications — `GET /notifications` → `Notifications` (chunk 6128) — UNVERIFIED (path guessed)
`data.notifications[]`: `id, body, createdAt ("MM/DD/YYYY …"), url`. Past two
months only.

### 3.14 Post-a-job form data — `GET /bookings/create[/{sitterAccountId}]` → `PostAJob` (chunk 8383, form module 6364) — UNVERIFIED (base path inferred)
`data`: `isActive`, `serviceAreaId`, `numKids`, `numPets`, `addr` (default),
`hasSubscription`, `org`, `availablePromoCodesMap`, `sitterAccountId`,
`sitterUserFullName`, `sittingDateTimes` (`date|start|end`), `baseRates`,
`surgePrices`, `lists` (`addrs`, `services`, `daysOfTheWeek`,
`tipPercentages`, `availablePromoCodes`, `yesNo`, `bookingStatuses`).
`baseRates` (cents/hour), possibly keyed by serviceAreaId: `babysitting1Kid`,
`babysitting2Kids`, `babysitting3Kids`, `babysitting4Kids`, `multisitter`,
`petsitting1Pet`, `petsitting2Pets`, `petsitting3Pets`,
`petsitting4OrMorePets`. Services: `babysitting`, `petsitting`,
`homeschool_help`. Needed by `juggle_post_job` to resolve `addr` ids/service ids
and preview the fee.
Helper: `GET /bookings/create/check-sitter-availability?sitterAccountId=&startDate=&startTime=&endDate=&endTime=` → `{sitterIsAvailable}`.

### 3.15 Locations (public, no auth) — `GET /locations` → `Locations` (chunk 1503) — shape seen live anonymously
`data.states`: `{ "<State>": { locations: [{ city, img, details (HTML with
email + babysitting/petsitting rates), showDetails }] } }`. Rates are prose in
`details` HTML — parse with `htmlToReadableText`.

### 3.16 Other public pages (seen live): `/faqs` → `Faqs` `data.family[]`/… `{question, answer(HTML), show}`; `/how-to-join` → `{promoCodeAmount}`.

### Not family-relevant / out of scope
`/open-jobs` (OpenJobs, sitter), `/availability` (sitter's own), `/families/{profileId}`
(FamilyDetails — sitter's view of a family), start/stop booking, apply-to-job,
accept-job/decline-job (sitter), admin routes, group-admin routes,
`/api/v1/users/me/geolocation`.

## 4. Writes

Implemented in `src/tools/writes.ts` (confirm-gated, `defineWrite` + `registerWrite`). Single accept/decline sends `{}` (the UI passes `forAll` only for "… for All Jobs"); favorites and reviews accept a non-JSON 2xx because the UI ignores those bodies. **All UNVERIFIED until the live write pass below.**

All carry the §2 headers; JSON bodies. Responses commonly use
`{error: true, msg}` **with HTTP 200** for business failures — a 200 is not
success until `error` is checked.

| Tool | Method + path | Body (from call site) | Response (bundle) | Chunk |
|---|---|---|---|---|
| `juggle_post_job` | `POST /bookings` | see below | `{error, msg}`; success → no id returned (UI just shows success) | 8383 / 6364 |
| `juggle_accept_sitter` | `PATCH /bookings/{bookingId}/accept-sitter/{sitterAccountId}` | `{forAll?: bool}` (true = all open jobs in a reoccurring series) | `{error?, msg?, status, displayStatus, numBookedSitters, bookingSitters, bookingRequests}` | 6891 |
| `juggle_decline_sitter` | `PATCH /bookings/{bookingId}/decline-sitter/{sitterAccountId}` | `{forAll?: bool}` | `{bookingSitters, bookingRequests}` | 6891 |
| `juggle_cancel_booking` | `PATCH /bookings/{bookingId}/cancel` | `{requireCancellationPenalty, cancellationReason, otherCancellationReason, cancellationPenalty}` | `{error, msg}` / `{confirmationRequired, paymentIntent, cancellationFee, bookingSitterFees, …}` / `{redirectToBookings}` | 1256 |
| `juggle_send_message` | `POST /messages` | `{conversationId, type: "text", content}` | `{error?, msg?, messages: [...]}` (full refreshed thread) | 8628 |
| `juggle_favorite_sitter` | `POST /favorites/{sitterAccountId}` | none | (ignored by UI) | 7250 |
| `juggle_unfavorite_sitter` | `DELETE /favorites/{sitterAccountId}` | none | (ignored by UI) | 7250 |
| `juggle_leave_review` | `POST /reviews/{bookingId}/{revieweeAccountId}` | `{rating, comments, outsideApp}` | UI ignores body; redirects to `/bookings/{bookingId}` | 30 |

### 4.1 `POST /bookings` (create) — body fields
Family create sends (`edit`/`admin` are absent for a family create; `edit:true`
+ `id` for the edit page `/bookings/{id}/edit`, chunk 5492):
`markBookingAsAddedEditedBySetUser: 1`, `serviceAreaId`, `service`
(`babysitting|petsitting|homeschool_help`), `status` (null on create),
`startDate` (YYYY-MM-DD), `startTime` (HH:MM), `willSpanMultipleDays` (0/1 —
UI sets 1 and endDate = startDate+1 when `endTime <= "05:00"`), `endDate`,
`endTime`, `flexibleEndTime`, `numUnpaidHours`, `sitterActualStartEndDateTimes`,
`isReoccurringBooking` (0/1), `reoccurringBookingDaysOfTheWeek[]`,
`reoccurringUntilDate` (UI caps at start + 3 months),
`reoccurringBookingOneSitterOnly` (0/1/null),
`sendRequestToSitterForEntireReoccurringSeries` (true), `numKids`, `numPets`,
`addr` (id from `lists.addrs`), `specialInstructions`, `emergencyBonusAmt`,
`juggleEmergencyBonusAmt`, `postOnOpenJobs` (bool, default true),
`postAsBackup` (bool, default true), `includeTransporationCosts` (sic, bool),
`enableAutopay` (bool), `autopayTipPercent[]`, `autopayTipAmt`,
`autopayPromoCodesGiftCards[]`, `sitterAccountId` (invite a sitter),
`sitterIsAvailable`, `userId` (null), `id` (null).
Required client-side: `service`, `startDate`, `startTime`, `endTime`, `addr`.
**Money-moving fields are out of scope:** the MCP must send
`emergencyBonusAmt: null`, `juggleEmergencyBonusAmt: null`,
`enableAutopay: false`, `autopayTipPercent: []`, `autopayTipAmt: null`,
`autopayPromoCodesGiftCards: []`. Multi-sitter: `numSitters = ceil(numKids/4)`.
Fee preview: `numSitters × hourlyRate(baseRates, numKids|numPets) × hours`
(+ surge pricing windows in `surgePrices`).
After success there is no id in the response — find the new booking via
`GET /bookings` (match start date/time/service) to report it.

### 4.2 Cancel booking — money guard
Page `GET /bookings/{bookingId}/cancel` (`CancelBooking`, chunk 1256) `data`:
`bookingId`, `userType`, `cancelingTooCloseToBookingStart`,
`requireCancellationPenalty`, `cancellationFee` (cents, 15%),
`bookingStarted`, `publishableKey`, `lists.bookingCancellationReasons`.
- Family inside 12 h of start (or after start) must choose
  `cancellationPenalty: "oneStarReview" | "cancellationFee"`.
- `cancellationFee` → server answers `confirmationRequired` + a Stripe
  PaymentIntent the browser confirms, then
  `PATCH /bookings/{id}/confirm-booking-cancellation` — **charges a card → OUT
  OF SCOPE. The MCP must never send `cancellationFee`.** If
  `requireCancellationPenalty` (or `cancelingTooCloseToBookingStart`) is true,
  `juggle_cancel_booking` refuses unless the caller passes
  `accept_one_star_review: true`, then sends `cancellationPenalty:
  "oneStarReview"`; any `confirmationRequired` response is reported as "not
  cancelled — finish on the website" and the payment intent is never read
  back. (Implemented choice; the owner can tighten it to a plain refusal.)
- `cancellationReason` is required (an id from `lists.bookingCancellationReasons`).
- Series cancel: `POST /bookings/{id}/cancel-all-open-and-booked-reoccurring-jobs`
  → `{error?, msg, status, displayStatus, reoccurringSeries, bookingSitters,
  bookingRequests}` — not in scope.

### 4.3 Send message
Needs a `conversationId`: from the conversation page `data.conversationId`
(§3.11). `content` is plain text (UI renders `\n` as `<br>`). Image messages
(`type:"image"`, content = uploaded URL via `POST /upload`) out of scope.
Subscription gating: `canSendMsg` false on a sitter profile ⇒ expect `error`.
Response returns the full `messages[]` — use it to confirm the send.

### 4.4 Leave review
Page `GET /reviews/create/{bookingId}/{revieweeAccountId}` (`LeaveAReview`,
chunk 30) `data`: `bookingId`, `accountId`, `userName`, `userType`,
`reviewAlreadyProvided`, `lists.yesNo`. `rating` 0–5 in **0.5 steps** (UI
default 5); `comments` text or null; `outsideApp` 0/1 (UI default 0; the
question is only shown when reviewing a family). Reviewable only when booking
`status ∈ {awaiting_payment, awaiting_review, completed, failed_payment}` and
the sitter is not in `sitterIdsWithBookingReviews`.

### Related writes seen but NOT in the owner's scope
`POST /sitters/request-sitter` `{bookingId, sitterAccountId,
optionalSitterMessage, returnBookingSitters}` (invite a sitter to an existing
job), `PATCH /bookings/{id}/remove-sitter/{accountId}` (un-book an accepted
sitter), `PATCH /bookings/{id}/renew-applications`, friends
(`POST|DELETE /friends/{id}`), `PATCH /my-profile`, `PATCH /messages/flag-message/{id}`,
conversation archive/unarchive, and everything money-moving: tips
(`/sitters/{profileId}/save-tip`, `confirm-save-tip`, `submit-tip`),
`/bookings/{id}/confirm-payment`, `/bookings/{id}/confirm-hours…`,
`confirm-booking-cancellation`, gift cards, subscriptions, payment methods,
Stripe links.

## 5. Live verification checklist (first authenticated pass)

Use the owner's family account; record status + body SHAPE only (never values)
into the fixtures/doc. Tick each item and drop UNVERIFIED from its section.

- [ ] `POST /log-in` success shape: status, `{error:false?, redirectUrl}`, which cookies rotate.
- [ ] Whether the pre-login `X-CSRF-TOKEN` still works after login, or a fresh `meta.csrfToken` / `X-XSRF-TOKEN` is required (try a harmless write-free check: a GET is CSRF-exempt, so test on the first real write).
- [ ] Signed-out XHR to a page route (e.g. `/bookings`): 302 to `/log-in`? 401 JSON? 200 `meta.page:"LogIn"`? → finalises `isExpired`.
- [ ] Stale session cookie on a write: 419? 401? → finalises replay rule.
- [ ] `GET /` (XHR) → `meta.page === "HomeFamily"`, `user.type === "family"`, `user.accountId` present.
- [ ] `GET /my-profile` data keys (§3.2) and item keys of `addrs/kids/pets`.
- [ ] `GET /bookings` item keys (§3.3); full status vocabulary.
- [ ] `GET /bookings/{id}` keys incl. `bookingSitters[]` / `bookingRequests[]` item keys.
- [ ] `GET /sitters` with and without filters; `numSitters` honoured; array params encoding (`services[]=` vs `services=`).
- [ ] Any favourites filter on `/sitters` (try `favorites=1`), else confirm the isFavorite-scan approach.
- [ ] `GET /sitters/{profileId}` keys; confirm profileId vs accountId vs userId mapping.
- [ ] `GET /sitters/{profileId}/schedule` + `go-to-week` shape.
- [ ] `GET /reviews/{accountId}` item keys.
- [ ] `GET /messages` and `GET /web-api/conversations` item keys; actual `conversation.url` pattern.
- [ ] Does `GET /messages/users/{userId}` create a conversation as a side effect?
- [ ] Conversation page keys (`conversationId`, `messages[]`, `isActive`).
- [ ] `GET /payments` keys + the three JSON helpers; confirm nothing secret leaks into the projection.
- [ ] `GET /notifications` path + shape.
- [ ] `GET /bookings/create` path (+ `/{sitterAccountId}`) and `lists.*` option shapes, `baseRates` keyed or flat.
- [ ] `GET /bookings/{id}/cancel` and `GET /reviews/create/{bookingId}/{accountId}` shapes.
- [ ] Writes — only with the owner's explicit go-ahead per call, on throwaway data: `POST /bookings` (then cancel it), favorite/unfavorite round-trip, send a message to a known contact, accept/decline on a real application, leave a review on a completed booking. Record the success body for each (does `POST /bookings` return an id?).
- [ ] Whether a 2xx with `{error:true}` vs a 4xx/422 is used for validation failures on each write.
- [ ] `X-Client: Website` and `timestamp` param — required or ignorable?
