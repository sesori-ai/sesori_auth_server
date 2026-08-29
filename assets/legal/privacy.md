# Sesori Privacy Policy

_Last updated: August 29, 2026_

This Privacy Policy explains how **Digitalblock Labs LTD** ("**Sesori**," "**Company**," "we," "us," or "our") collects, uses, stores, shares, and otherwise processes personal data when you use Sesori's official apps and services. It applies only to the official Sesori services, including the Sesori mobile app, the official local bridge software, relay services, account and authentication services, push notification services, `sesori.com`, voice input and server-side transcription features, project-scoped glossary features, diagnostics, analytics, mobile advertising attribution, website analytics and advertising technologies, support channels, and related hosted features we provide (collectively, the "**Service**").

This Privacy Policy does **not** apply to source builds, self-hosted deployments, unofficial builds, modified versions, forks, community distributions, or other non-official deployments, except to the extent those versions connect to an official Sesori-hosted feature. In that case, this Privacy Policy applies only to the official hosted feature interaction.

## 1. How Sesori works

Sesori is designed to help you monitor and interact with compatible AI coding assistants running on your own host system from your phone. The Service may include a local bridge running on your device, relay infrastructure, account and authentication services, push notifications, websites, diagnostics, product and website analytics, mobile advertising attribution, advertising audience tools, voice input, server-side transcription, and other related hosted features.

In ordinary operation, Sesori infrastructure routes encrypted relay traffic between your devices. That ordinary relay routing does **not ordinarily require Sesori to have plaintext access** to relay payloads in transit. Some specific features you use, or that operate as part of the Service, do require Sesori or its sub-processors to receive readable data, including voice input and server-side transcription, project glossary features, short text feature processing such as session title naming and branch naming, push payload snippets, and support or diagnostic review.

## 2. Controller and contacts

For the official Service covered by this Privacy Policy, the data controller is:

> **Digitalblock Labs LTD**
> BVI Company No. 2115105
> Registered in the British Virgin Islands

You can contact us at:

- [contact@sesori.com](mailto:contact@sesori.com) for general privacy and support matters
- [gdpr@sesori.com](mailto:gdpr@sesori.com) for GDPR and data protection rights matters

### 2.1 EU Representative

Because Digitalblock Labs LTD is established outside the European Union, we have appointed the following entity as our representative in the European Union under Article 27 of Regulation (EU) 2016/679 ("**GDPR**"):

> **Efosoft EOOD**
> UIC 207932888
> Email: [gdpr@sesori.com](mailto:gdpr@sesori.com)

Individuals located in the EU or EEA may contact our EU Representative directly regarding the processing of their personal data or the exercise of their rights under the GDPR.

Efosoft EOOD is a related party under common ownership with Digitalblock Labs LTD.

## 3. Categories of data we process

Depending on how you use the Service, we may process the following categories of personal data.

### 3.1 Account and authentication data

- account identifiers
- email address and sign-in related information
- authentication and session tokens
- account status and basic account records
- identity provider information when you choose Apple, Google, or GitHub sign-in

### 3.2 Connection and session metadata

- relay connection metadata
- session identifiers and project identifiers
- timestamps, event timing, delivery status, and routing metadata
- limited metadata about connected bridge or mobile sessions

### 3.3 Device and app metadata

- device type, operating system, app version, build identifiers, and similar app environment data
- IP address and general network or connectivity diagnostics
- mobile platform identifiers needed for app operation, notifications, fraud prevention, or security review

### 3.4 Push notification data

- push notification tokens
- notification delivery metadata
- notification payload data, including limited session metadata or partial snippets when a feature or platform flow includes them

Depending on your device settings, platform behavior, notification routing, and lock-screen controls, push notifications may display limited session metadata or partial snippets on device-level notification surfaces.

### 3.5 Analytics, crash, and diagnostic data

- product usage events, including bounded feature outcomes and canonical screen categories
- performance metrics
- crash logs and stack traces
- diagnostic events and troubleshooting data

Supported release builds may associate account-linked product analytics events with a stable, server-derived pseudonymous account key. This key helps us understand product usage across supported installations signed in to the same account. It is pseudonymous personal data, not anonymous data, and is not the raw account identifier.

Sesori-defined account-linked product analytics event payloads cannot contain source code; prompts, responses, transcripts, or reasoning; filenames or paths; repository, project, or session names; coding provider, model, agent, tool, or command names; raw error text; OAuth identity; email address; IP address; or raw or hashed project, session, bridge, device, notification, or account identifiers.

These payload restrictions apply specifically to Sesori-defined account-linked product analytics events. Firebase may separately process automatic installation-level data as described in Section 14, and the website analytics, mobile attribution, advertising audience, operational, support, security, crash, or diagnostic processing described elsewhere in this Privacy Policy is outside this event contract.

### 3.6 Support communications

- emails you send us
- attachments, logs, screenshots, or descriptions you provide in support requests
- our support responses and related internal notes

Support is currently provided by email only.

### 3.7 Voice recordings and transcripts

- voice recordings you submit through voice input features
- generated transcripts and related processing outputs

Voice recordings are transmitted to Sesori servers and a third-party transcription sub-processor for processing. We do not retain voice recordings or generated transcripts after processing completes, except to the limited extent reasonably necessary for service operation, abuse prevention, security, incident response, or as required by law.

### 3.8 Limited readable feature-processing and project glossary data

- limited readable inputs and outputs needed to operate specific invoked features, such as session title naming, branch naming, or similar short text feature processing
- limited readable snippets needed for push notifications, support, diagnostics, abuse review, or security investigation
- bounded project glossary terms (keywords) derived locally by the Bridge from project names, repository names, tracked or local path names, and selected project metadata files, or otherwise supplied through a glossary feature
- opaque project-scope keys and, for bridge-local projects, a bridge identifier associated with those terms

For the glossary feature, which the Bridge may populate when a project is loaded or viewed, the Bridge sends selected derived terms, an opaque project key, and, where applicable, a bridge identifier to Sesori. The project key is a pseudonymous identifier linked to your account, not anonymous data. It does not send the raw repository origin, filesystem path, or source-file or metadata-file contents as part of glossary publication. Derived terms can nevertheless reveal project characteristics, technical identifiers, names, or other personal or confidential information; credential filtering is heuristic and is not a guarantee. Sesori stores the terms in an account- and project-scoped glossary and may send selected terms to the configured transcription provider as context when you use voice transcription for that project. Glossary terms are not sent to website analytics, advertising, or account-linked product-analytics events.

### 3.9 Website analytics and advertising data

Subject to the choices presented through our cookie banner and Cookie Settings control, `sesori.com` uses Google Analytics 4 (measurement ID `G-5R35L8J3NT`) and Meta Pixel (pixel ID `1619146889579169`) to measure website use, acquisition, advertising performance, and actions such as store visits, documentation visits, or Bridge installation interactions. In jurisdictions where prior consent is required, non-essential analytics and advertising tags remain disabled until the visitor grants the relevant consent.

Depending on the technology, configuration, and your interaction with the website, this processing may include:

- pages viewed, page titles, referring URLs, and the date and time of a visit
- button clicks, page-view events, store or documentation visits, install interactions, and similar conversion events
- campaign, referral, and advertising click parameters
- browser type, device type, operating system, language, screen characteristics, and general interaction data
- IP address and approximate location derived from network information
- cookie, browser, advertising, and similar online identifiers, including identifiers such as `_ga`, `_ga_*`, `_fbp`, and `_fbc`

Google and Meta may associate these identifiers and events with other information available to them under their own terms and privacy policies. We do not intentionally send source code, prompts, AI responses, repository names, file paths, terminal output, authentication tokens, form contents, or other coding-session content through these website tags.

### 3.10 Mobile advertising attribution data

Official mobile release builds for which Sesori enables advertising attribution use the Singular Flutter SDK to attribute installs and re-engagements, measure campaign performance, detect attribution fraud, support deep links, and understand whether advertising leads to useful product outcomes. Singular is not enabled in development, self-hosted, or other builds where the SDK or required configuration is absent.

Depending on device settings, platform availability, consent choices, and our SDK configuration, Singular may process:

- IP address, user agent, device model, operating system, app version, installation, session, and general app-event data
- country, region, or approximate geolocation derived from network or device information
- advertising and device identifiers such as IDFA on iOS, Google Advertising ID on Android, IDFV, App Set ID, or a Singular-generated device identifier
- app-store referral, campaign, ad-network, click, impression, deep-link, and attribution information
- custom product events and purchase or revenue information only where we deliberately configure those events
- a pseudonymous internal user identifier if we deliberately configure one for cross-device attribution; we do not use a raw email address as the Singular user ID

Singular processes this information on our behalf and may send attribution data or configured postbacks to advertising partners according to our campaign and partner settings. Limiting partner sharing does not necessarily stop Singular's own SDK measurement. Platform tracking permissions and the controls described in Section 14 apply.

### 3.11 Meta Customer List and Lookalike Audiences

We may use the email address associated with your Sesori account to create advertising audiences on Meta platforms where we have the consent or other lawful permission described below.

Before transfer for customer-list matching, we normalize and cryptographically hash the email address. Hashing reduces direct exposure during transfer but does not make the information anonymous. Meta uses the hashed value to determine whether it matches a Meta account and to create a Customer List Custom Audience. Meta does not tell us which specific people matched.

We may use the resulting Custom Audience to:

- advertise Sesori to existing users or exclude existing users from acquisition campaigns
- measure campaign reach or effectiveness
- ask Meta to create a Lookalike Audience of other Meta users with characteristics similar to the matched audience

Where applicable law requires consent for this processing, we obtain a separate advertising-audience consent rather than treating account creation or this Privacy Policy itself as consent. Audience matching is not required to use Sesori's core functionality. You may withdraw consent or opt out through the privacy controls described in Sections 14 and 17 or by contacting [contact@sesori.com](mailto:contact@sesori.com) or [gdpr@sesori.com](mailto:gdpr@sesori.com). After a valid opt-out, we will stop including the address in future audience uploads and remove it from active customer-list audiences within a reasonable period, subject to Meta's processing and retention systems.

This audience matching does not by itself subscribe you to marketing email. Meta Customer List Custom Audiences are governed by the [Meta Customer List Custom Audiences Terms](https://www.facebook.com/legal/terms/customaudience) and [Meta Business Tools Terms](https://www.facebook.com/legal/technology_terms).

## 4. Sources of data

We collect personal data from the following sources:

- directly from you, such as when you create or use an account, send us an email, submit voice input, or contact support
- from your devices and apps when they connect to or interact with the Service
- from the local Bridge, which derives bounded project glossary terms from local project names, path names, and selected metadata files before publishing selected terms to the Service
- from your chosen identity provider, such as Apple, Google, or GitHub, when you use that sign-in option
- from our service providers and infrastructure providers that help us operate the Service
- from automated logs, analytics, crash reporting, and security systems generated during Service operation
- from your browser when you visit `sesori.com`, interact with website controls, or arrive through an advertising or campaign link
- from advertising, analytics, and attribution providers when they report campaign, install, re-engagement, conversion, or audience-match results

## 5. How we use personal data

We use personal data for the following purposes:

- providing, operating, and maintaining the Service
- authenticating users and managing accounts
- routing connections, delivering notifications, and operating relay or hosted features
- operating voice input and server-side transcription features
- maintaining project-specific glossary context and applying selected terms to voice transcription requests
- performing limited feature processing you invoke, such as session title naming, branch naming, or similar processing
- securing the Service, preventing abuse, investigating suspicious activity, and responding to incidents
- monitoring reliability, diagnosing failures, fixing bugs, and improving performance
- analyzing product usage so we can understand how the Service is used and improve it
- understanding website traffic, referral sources, and interactions with our public pages
- attributing installs and re-engagements and measuring advertising or acquisition campaign performance
- creating, excluding, measuring, or finding similar advertising audiences where permitted by law
- communicating with you about the Service, including support and operational notices
- complying with legal obligations, enforcing our terms, and protecting our rights, users, systems, and providers

We use account-linked product analytics data solely to understand and improve Sesori. We do not use the restricted product analytics events described in Section 3.5 for advertising or disclose those events to business partners for their independent use. This limitation does not apply to the separate website analytics, mobile attribution, or advertising audience processing described in Sections 3.9 through 3.11. Google, Meta, Singular, and configured advertising partners process that separate data for the measurement, attribution, audience, and advertising purposes disclosed in this Privacy Policy.

## 6. When Sesori processes readable content

Sesori does **not** ordinarily have plaintext access to encrypted relay payloads in transit during ordinary relay routing.

Sesori and its sub-processors process readable data in limited situations where readable processing is required for a feature you use or for operational needs, including:

- voice input and server-side transcription
- project glossary publication, storage, and context selection
- short text feature processing, such as session title naming and branch naming
- push notification payload snippets or limited metadata
- support, troubleshooting, diagnostics, abuse prevention, trust and safety review, security investigation, or incident response

Where possible, we try to keep readable processing limited to what is needed for the relevant feature or operational purpose.

## 7. Legal bases for processing

If GDPR or similar law applies, we generally rely on one or more of the following legal bases:

- **Performance of a contract** (GDPR Art. 6(1)(b)), when processing is needed to provide the Service you request
- **Legitimate interests** (GDPR Art. 6(1)(f)), when processing is needed to secure, maintain, support, analyze, administer, or protect the Service and we have determined our interests are not overridden by your rights. You may object to processing based on legitimate interests as described in Section 15
- **Consent** (GDPR Art. 6(1)(a)), where consent is required by law or where we specifically ask for it, for example for certain analytics or tracking on supported platforms. You may withdraw consent at any time
- **Legal obligation** (GDPR Art. 6(1)(c)), when processing is needed to comply with law, regulation, lawful requests, or mandatory recordkeeping requirements

For website advertising technologies, mobile attribution, Meta Customer List Custom Audiences, Lookalike Audiences, and similar targeted-advertising processing, the legal basis depends on the jurisdiction and configuration. In jurisdictions where prior consent is required, our cookie banner keeps non-essential website analytics and advertising tags disabled until the relevant consent is granted, and we obtain separate consent for customer-list audience matching where required. Where the law permits processing based on legitimate interests, those interests include measuring acquisition, preventing attribution fraud, avoiding irrelevant advertising, and operating sustainable marketing, balanced against the rights of affected individuals. Platform permission frameworks such as Apple's App Tracking Transparency are separate from, and do not replace, any consent required under data-protection or electronic-communications law.

## 8. Sub-processors and third-party recipients

### 8.1 Service providers and technology recipients

We use service providers, analytics providers, attribution providers, and advertising platforms to operate, measure, secure, and market the official Service. Some process personal data solely on our behalf and instructions; others may have separate responsibilities under their own terms and applicable law. Current recipients include:

| Provider                               | Role                                                                                                                                                                       | Location of processing                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| DigitalOcean, LLC                      | Hosting, infrastructure, and databases, including project glossary storage                                                                                                  | European Union (Sesori-controlled servers are currently EU-hosted); provider headquartered in the United States |
| Cloudflare, Inc.                       | Reverse proxy, DNS, security edge services, and related network infrastructure                                                                                            | Global edge network; provider headquartered in the United States                                                |
| OpenAI, L.L.C.                         | Voice transcription and short text feature processing, including glossary context supplied with a voice request                                                            | United States                                                                                                   |
| Soniox, Inc.                           | Voice transcription, including glossary context supplied with a voice request                                                                                              | United States (US regional project)                                                                              |
| Anthropic, PBC                         | Short text feature processing (e.g., session title naming)                                                                                                                 | United States                                                                                                   |
| Google LLC (Firebase, Google Cloud, and Google Analytics) | Push notifications, app and website analytics, campaign measurement, restricted analytics storage and processing via BigQuery, and Crashlytics                            | United States and Google global infrastructure                                                                  |
| Meta Platforms Ireland Limited and Meta Platforms, Inc. | Meta Pixel, advertising measurement and optimization, Customer List Custom Audiences, Lookalike Audiences, and related Meta advertising services                          | European Union, United States, and Meta global infrastructure                                                    |
| Singular Labs, Inc.                    | Mobile install and re-engagement attribution, campaign analytics, deep linking, fraud prevention, and configured advertising-partner postbacks                             | United States and Singular global infrastructure                                                                |
| Functional Software, Inc. (Sentry)     | Error monitoring and crash diagnostics                                                                                                                                     | United States                                                                                                   |

Google, Meta, Singular, and configured advertising partners may receive the identifiers, events, and campaign data described in Sections 3.9 through 3.11. Their processing is also governed by the applicable provider terms and privacy documentation, including [Google's Privacy Policy](https://policies.google.com/privacy), [Meta's Business Tools Terms](https://www.facebook.com/legal/technology_terms), [Meta's Customer List Custom Audiences Terms](https://www.facebook.com/legal/terms/customaudience), and [Singular's Privacy Policy](https://www.singular.net/privacy-policy/).

We also operate our own Sesori authentication backend on Sesori infrastructure for account and authentication services.

The list of sub-processors may change as the Service evolves. We will update this Privacy Policy to reflect changes.

### 8.2 Identity providers and platform ecosystems you choose

You may choose to use independent third-party platforms or identity providers, which have their own privacy practices and are not acting as Sesori sub-processors for all purposes:

- **Apple Inc.**, for app distribution via the Apple App Store, Apple sign-in, and related platform and notification services
- **Google LLC**, for app distribution via the Google Play Store, Google sign-in, and related platform services
- **GitHub, Inc.**, when you choose GitHub as an identity provider

### 8.3 Other disclosures

We may also disclose personal data where reasonably necessary to:

- comply with applicable law, regulation, legal process, or lawful requests from public authorities
- protect the rights, property, safety, or security of Sesori, our users, our providers, or the public
- detect, prevent, or investigate fraud, abuse, security incidents, or violations of our terms
- enforce our terms or defend legal claims

In the event of a merger, acquisition, financing, reorganization, bankruptcy, or sale of all or part of our business or assets, personal data may be transferred to the acquiring or successor entity. We will seek to ensure that any recipient continues to protect personal data consistent with this Privacy Policy.

### 8.4 No monetary sale; analytics and advertising disclosures

Sesori does **not** sell personal data for money. We disclose website activity, online identifiers, mobile attribution data, campaign events, and hashed account email addresses to Google, Meta, Singular, and configured advertising partners for analytics, attribution, campaign measurement, audience matching, advertising optimization, and targeted advertising as described in this Privacy Policy.

Under some United States privacy laws, some of these disclosures may be considered "sharing," targeted advertising, or cross-context behavioral advertising even when no money is exchanged. Where applicable, you may opt out immediately through the Cookie Settings or "Do Not Sell or Share My Personal Information" control on the website or app. We also treat a recognized opt-out preference signal, including Global Privacy Control, as an opt-out request for the browser or device that sends it where required by law. You may additionally contact [contact@sesori.com](mailto:contact@sesori.com) or [gdpr@sesori.com](mailto:gdpr@sesori.com). We will apply a valid opt-out to future audience uploads and advertising-data sharing under our control and will request removal from active customer-list audiences where applicable.

## 9. International data transfers

Sesori and its sub-processors may process personal data in countries outside your own, including jurisdictions outside the European Union or European Economic Area, such as the United States.

Where personal data of individuals in the EU, EEA, or United Kingdom is transferred to a jurisdiction that has not been recognized by the European Commission or the UK Government as providing an adequate level of data protection, we rely on appropriate safeguards permitted under GDPR Chapter V and the UK GDPR. These safeguards are typically the European Commission's Standard Contractual Clauses (SCCs, Decision (EU) 2021/914), together with the UK International Data Transfer Addendum or the UK International Data Transfer Agreement where applicable, and any supplementary measures we consider appropriate.

You may request a copy of the safeguards applied to specific transfers by contacting us at the addresses in Section 2.

## 10. Data retention

We keep personal data for as long as reasonably needed for the purposes described in this Privacy Policy, taking into account the nature of the data, why it was collected, operational needs, security, legal obligations, and dispute or enforcement needs.

Indicative retention practices:

- **Ordinary relay traffic**: designed to be routed in encrypted form and is ephemeral from Sesori's perspective
- **Voice recordings and generated transcripts**: deleted after processing completes, typically within seconds of the processing flow, except to the limited extent reasonably needed for operations, abuse prevention, security, incident response, or legal compliance
- **Project glossary terms and associated scope metadata**: retained in the account- and project-scoped glossary while needed to provide project-specific voice features. Bridge-local terms are removed when their bridge scope is revoked; repository-scoped terms may remain after a bridge disconnects until you or the Bridge removes them, the project is reconciled, or we process a verified erasure request. There is currently no fixed time-based expiration for an active repository-scoped glossary. Limited records may be retained as reasonably needed for security, legal, support, or dispute purposes
- **Account and authentication data**: retained while your account exists and thereafter for a reasonable period, typically up to 24 months, for security, fraud prevention, legal compliance, dispute handling, or enforcement
- **Push notification tokens**: retained while needed for notification delivery and removed or allowed to expire when you log out, rotate tokens, uninstall the app, or when the token becomes stale
- **Google Analytics website and product analytics data**: upstream event and user data retention is configured to two months
- **Meta Pixel and Meta advertising data**: retained by Meta according to the applicable Meta terms and our advertising-account settings; campaign reports and audience records may remain while needed for the disclosed advertising purposes
- **Meta customer-list audience data**: hashed customer-list data is used by Meta for matching under its Customer List Custom Audiences Terms; we remove opted-out users from future uploads and request removal from active customer-list audiences within a reasonable period
- **Singular attribution data**: retained according to our Singular settings, Singular's processor terms, and the period needed for attribution, fraud prevention, campaign analysis, rights requests, and legal obligations
- **Restricted raw BigQuery analytics export**: raw exported analytics data expires after 90 days
- **Curated product analytics data**: minimized pseudonymous event facts are retained for up to 14 months; routine product and dashboard viewers cannot access raw analytics datasets or pseudonymous account keys
- **Crash and diagnostic data**: retained according to vendor settings and our operational needs, typically up to 90 days for crash and error reports
- **Support communications**: retained for up to 24 months after the issue is resolved, and longer where reasonably needed for follow-up, legal, security, or compliance reasons
- **Server and security logs**: retained for a limited period typically up to 90 days, subject to extension where needed for security investigation or legal compliance

When retention is no longer justified, we delete, anonymize, or aggregate the data where feasible.

## 11. Security

We use measures intended to protect personal data and the Service, including access controls, encryption in transit, authentication controls, logging, monitoring, and operational safeguards.

No method of storage, transmission, or processing is completely secure. We cannot guarantee absolute security.

If we become aware of a personal data breach that creates a risk to your rights and freedoms, we will notify the relevant supervisory authority and, where required, affected individuals, in accordance with applicable law.

## 12. Model training

Sesori will **not** use your content, including voice recordings, transcripts, or project glossary terms, to train machine learning or AI models, whether general-purpose or Sesori-specific.

OpenAI and Soniox may receive selected project glossary terms as context with a voice transcription request; Anthropic is used for short text feature processing. Our agreements with these sub-processors prohibit them from using your inputs or outputs processed on our behalf to train their general-purpose or foundation models. We rely on the API and enterprise data processing terms offered by these providers, which include no-training commitments for data submitted through their APIs.

Voice transcription is served by one configured provider at a time. When Soniox is configured for the official Service, audio is processed and temporarily stored in Soniox's United States regional project. Audio submitted for file-based transcription is stored by the provider only for as long as the transcription job requires and is deleted immediately after the transcript is returned; in rare cases such as an unexpected server restart, residual audio may persist briefly until an operator cleanup removes it. If live transcription is enabled later, live transcription audio will be processed in transit and not retained by the provider. Sesori does not store your audio or transcripts.

## 13. Automated decision-making

We do not use your personal data for solely automated decision-making that produces legal or similarly significant effects concerning you within the meaning of Article 22 GDPR.

## 14. Analytics, diagnostics, advertising, and platform tracking controls

The Service currently uses analytics, diagnostic, and advertising tools in the apps and hosted features, including Firebase Analytics, Firebase Crashlytics, Sentry, Google Analytics 4, and Meta Pixel, to understand usage, detect failures, measure campaigns, and improve reliability. Official mobile release builds configured for advertising attribution also use the Singular Flutter SDK as described in Sections 3.10 and 14.2.

### 14.1 Account-linked product analytics control

Supported release builds provide a Settings control for account-linked product analytics. The control becomes interactive only after the app has obtained the authenticated server preference. Account-linked product analytics remains inactive while that preference is unknown.

Turning the control off suppresses account-linked product analytics events immediately on that installation and synchronizes the preference for reporting and other supported clients. A change made on one installation is not necessarily applied immediately on another installation. A remote supported installation applies the server preference when it next establishes authentication or explicitly refreshes the preference.

This control applies only to the account-linked product analytics events described in Section 3.5. It does not stop:

- Firebase automatic installation-level events or Firebase's processing of pseudonymous installation and device information and approximate location
- the bounded account-less sign-in funnel described below
- account and bridge records required to operate Sesori
- analytics behavior from an older app version
- account-linked events on a remote supported installation before it next establishes authentication or explicitly refreshes its preference
- separate crash and diagnostic processing through tools such as Firebase Crashlytics or Sentry
- website Google Analytics and Meta Pixel processing described in Section 14.3
- Singular install attribution, advertising-partner postbacks, or other mobile advertising processing
- Meta Customer List Custom Audiences, Lookalike Audiences, or other advertising audience processing

Before sign-in, supported release builds may send bounded events indicating that a sign-in attempt started, completed, or failed. These events contain only a pinned sign-in provider and, for failures, a bounded failure category. They contain no account key or attempt identifier. Because these events are account-less, we cannot reliably filter internal or test release traffic from them. We use them only as diagnostic information and do not treat them as an account conversion metric.

The Settings control is therefore not an account-wide, Firebase-wide, or diagnostics-wide collection switch, and it cannot change behavior in older app versions.

### 14.2 Mobile platform tracking and attribution controls

On iOS, we respect Apple's App Tracking Transparency framework. We do not access the IDFA or track you across apps and websites owned by other companies without the required ATT permission where ATT applies. ATT is a platform permission and is separate from any consent required under privacy law. Singular may still support privacy-preserving or non-IDFA attribution methods, such as Apple's attribution frameworks, subject to our configuration.

On Android, we respect Google's advertising identifier controls and applicable user choices. Availability of an advertising identifier depends on device, platform, account, age, and privacy settings.

Where supported by our implementation, Singular controls can limit data sharing with advertising partners or stop future SDK tracking. A request to withdraw applicable consent or opt out can also be submitted to [contact@sesori.com](mailto:contact@sesori.com) or [gdpr@sesori.com](mailto:gdpr@sesori.com). Stopping future tracking does not automatically retract data already transmitted, which remains subject to applicable deletion and rights-request processes.

### 14.3 Website analytics and advertising technologies

`sesori.com` presents a cookie banner and persistent Cookie Settings control for Google Analytics 4, Meta Pixel, and related non-essential technologies. In jurisdictions requiring opt-in consent, analytics and advertising tags remain disabled until the visitor accepts the relevant category. In jurisdictions that use an opt-out model, the tags operate subject to the visitor's saved preference and applicable opt-out rights.

You can accept, reject, or later change analytics and advertising choices through Cookie Settings. Where applicable, the website also provides a "Do Not Sell or Share My Personal Information" control and honors recognized opt-out preference signals such as Global Privacy Control for the browser or device that sends them. You can additionally block or delete cookies using browser controls, use [Google's Analytics opt-out tools](https://tools.google.com/dlpage/gaoptout), manage advertising preferences through [Meta's Ad Preferences](https://www.facebook.com/adpreferences/ad_settings), or submit a rights request using the contacts in Section 2. Rejecting these technologies may reduce the accuracy of campaign attribution but does not prevent access to Sesori's public website or core Service.

The Sesori Cookie Statement provides the current website technology inventory, cookie categories, typical lifespans, provider controls, and additional details about changing or withdrawing website choices. It supplements this Privacy Policy.

## 15. Children's privacy

The official Service is not directed to anyone under 16, except where applicable law in your jurisdiction allows valid consent to personal data processing at a lower age (in Bulgaria, the age is 14 under GDPR Article 8). If you are below the age at which you can validly consent to personal data processing under applicable law, you must not use the Service or submit personal data to us.

If you believe someone under the applicable age has provided us personal data, contact us at [contact@sesori.com](mailto:contact@sesori.com) and we will take appropriate steps to delete it.

## 16. Your privacy rights

Subject to applicable law, you may have the following rights in relation to your personal data.

### 16.1 Rights under the GDPR and UK GDPR

If GDPR or UK GDPR applies to you, you have the right to:

- **access** the personal data we hold about you (Art. 15)
- **rectify** inaccurate or incomplete personal data (Art. 16)
- **erase** personal data in certain circumstances (Art. 17)
- **restrict** processing in certain circumstances (Art. 18)
- **data portability** for data you provided to us where processing is based on consent or contract and is carried out by automated means (Art. 20)
- **object** to processing based on our legitimate interests (Art. 21)
- **withdraw consent** at any time where processing is based on your consent, without affecting the lawfulness of processing before withdrawal
- **lodge a complaint** with your local supervisory authority. If you are in Bulgaria, this is the Commission for Personal Data Protection (Комисия за защита на личните данни). In other EU/EEA member states, contact your national authority

### 16.2 How to exercise your rights

To exercise any of these rights, contact us by email at [gdpr@sesori.com](mailto:gdpr@sesori.com) or [contact@sesori.com](mailto:contact@sesori.com). We may ask for information needed to verify your identity before responding.

When we act on a verified account-deletion or analytics-erasure request, we can permanently suppress future account-linked product analytics reporting for that account and target associated keyed analytics data for deletion. A verified request may also cover project glossary terms and their associated scope metadata; because project keys are opaque, we identify those records through the account that owns them rather than requiring the raw repository path. Because a supported installation may upload an event after the initial deletion process, our deletion process repeatedly targets later uploads carrying the same pseudonymous account key.

Data from an automatic-only installation that never emitted an account-keyed event cannot be linked back to an account by design. We therefore cannot identify that installation's automatic data in response to an account request. It remains subject to Google Analytics' two-month upstream retention period, and an already-exported row in the restricted raw BigQuery dataset may remain until its 90-day expiration.

For website analytics, mobile attribution, or advertising audience data, a verified request may require us to stop future collection or sharing under our control, remove an email address from future audience uploads, request removal from active Meta customer-list audiences, or submit an applicable deletion or suppression request to Google, Meta, Singular, or another configured advertising partner. Data associated only with a cookie, device identifier, or advertising identifier may not be identifiable from an account email without additional information from you or the provider.

We aim to respond to rights requests within 30 days of receipt, with the possibility of an extension of up to two additional months for complex or numerous requests, consistent with GDPR Article 12. We do not currently offer self-serve in-app privacy rights workflows or in-account deletion flows. Rights requests are handled by email.

## 17. California privacy notice

This section applies to California residents to the extent required by the California Consumer Privacy Act as amended by the California Privacy Rights Act ("**CCPA/CPRA**").

We collect and use personal information as described in this Privacy Policy for service operation, security, support, diagnostics, analytics, advertising attribution, audience matching, targeted advertising, legal compliance, and related business purposes. The categories of personal information we collect correspond to the data categories described in Section 3.

- Sesori does **not** sell personal information for money
- Sesori may disclose online identifiers, website activity, mobile attribution data, campaign events, and hashed account email addresses to Google, Meta, Singular, and configured advertising partners
- these disclosures may constitute "sharing," targeted advertising, or cross-context behavioral advertising under CCPA/CPRA

To the extent we process sensitive personal information, we do so only to provide the Service or for closely related security, compliance, fraud-prevention, support, diagnostic, and operational purposes, within the limits permitted by CCPA/CPRA.

California residents may request to know, access, correct, or delete personal information; request to limit use of sensitive personal information; or opt out of sale, sharing, cross-context behavioral advertising, or targeted advertising. Where CCPA/CPRA applies, an immediate opt-out is available through the Cookie Settings or "Do Not Sell or Share My Personal Information" control on the website or app, and we honor recognized opt-out preference signals such as Global Privacy Control for the browser or device that sends them. Requests may also be submitted to [contact@sesori.com](mailto:contact@sesori.com) or [gdpr@sesori.com](mailto:gdpr@sesori.com). We will respond consistent with CCPA/CPRA, generally within 45 days of a verifiable request, with the possibility of an extension where permitted. We may need to verify your identity before responding. You may also designate an authorized agent to act on your behalf as permitted by California law.

We do not discriminate against California residents for exercising their privacy rights.

## 18. Changes to this Privacy Policy

We may update this Privacy Policy from time to time. When we do, we will post the updated version through the Service or at `sesori.com` and update the date at the top of the policy. If a change materially affects how we process your personal data, we will use reasonable efforts to provide additional notice, for example by email or in-app notice, before the change takes effect.

## 19. Contact us

If you have questions about this Privacy Policy or want to exercise privacy rights, contact:

- [contact@sesori.com](mailto:contact@sesori.com) for general privacy and support matters
- [gdpr@sesori.com](mailto:gdpr@sesori.com) for GDPR and data protection rights matters

**Digitalblock Labs LTD**
(Registered in the British Virgin Islands)

**EU Representative: Efosoft EOOD**
(Registered in Bulgaria)
