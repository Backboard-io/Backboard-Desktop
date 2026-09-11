# Microsoft Store certification

## Paste into Properties → Notes for certification (under Product declarations)

Backboard Studio 3.1.5 — certification access

Email: bburgers784@gmail.com
Password: password123!

Install and launch the app, enter these credentials in the Email/Password form, and click Sign In. No account creation, email verification, browser SSO, or payment is required for this test account. Internet access is required for AI features.

Complete or skip onboarding, then send “Explain what this IDE can help me build” in chat. Open a project folder to test project features. If onboarding was skipped, choose Sign In from the app and use the same credentials.

Uninstall: Windows Settings > Apps > Installed apps (Apps & features on Windows 10) > Backboard Studio > Uninstall. Publisher: Espri.ai. The per-user edition is named Backboard Studio (User).

Support: erin@backboard.io

## Release verification before submitting

- Build and sign a new Windows installer containing these changes. Existing installed builds do not change when source files are edited.
- Install that exact signed artifact on a clean Windows VM. Confirm its Name and Publisher in Add or Remove Programs, including after upgrading an earlier build.
- Follow the testing instructions above with the exact submission artifact and confirm the API key remains funded and enabled throughout certification.
- Paste the section above into Partner Center; this file is not submitted automatically.

Microsoft's [MSI/EXE certification guidance](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-certification-process) explains test-access requirements and product identification checks.

## Local validation — 2026-09-11

- The installed macOS app's About dialog reported **Backboard Studio Sandbox 3.1.3**. This is the existing installed build, not a rebuilt release with these changes.
- The supplied reviewer key returned HTTP 200 from the model-provider endpoint and HTTP 200 with an `OK` assistant reply from a small `gpt-4o-mini` request.
- 25 browser tests passed, covering reviewer sign-in, Simple-mode routing, tour positioning, credential removal, and account-button layout at 240, 440, and 768 pixels.
- Source and build type checks and extension compilation passed.
- Windows installer metadata is wired to `product.json`: product **Backboard Studio**, publisher **Espri.ai**. Native Windows installation and certification submission remain to be performed with the rebuilt, signed installer.

## Partner Center inspection — 2026-09-11

The live [Backboard Studio submission](https://partner.microsoft.com/en-us/dashboard/win32apps/0f759939-60fe-4ebd-aacd-2084b297aaaa/overview) is an EXE/MSI app in draft after a failed review. The [September 11 certification report](https://partner.microsoft.com/en-us/dashboard/win32apps/0f759939-60fe-4ebd-aacd-2084b297aaaa/certification/reports/8aec3968-fe38-4877-b9f9-4e2a0e8742e2) lists the publisher as **Espri.ai**. The installer metadata has been corrected to match that observed name.

The report contains two failures: **10.2.7 Security – Product Removal** (unrelated or blank uninstall Name/Publisher) and **10.3.1 App Is Testable – Test Account** (missing testing credentials). Both were tested on a Microsoft Surface Laptop.

The Packages page lists one **x64** package, ID **98198417**, modified **2026-09-08**; package validation is **Not initiated**. This package predates the local fixes. The package and Properties fields were inspected on the follow-up pass below. No package or listing edits have been saved, and nothing has been resubmitted.

### Package and Properties follow-up

- Submitted package URL: `https://backboard-studio-releases.s3.ca-central-1.amazonaws.com/ide-releases/stable/latest/bbide/windows-x86_64/Backboard-Studio-System-Setup-x64.exe`.
- The URL responds HTTP 200. At inspection, its Last-Modified header was **2026-09-06 14:43:42 UTC**, size **393,991,112 bytes**. The installer PE version resource reports **FileVersion/ProductVersion 3.1.1**, **ProductName Backboard Studio**, **CompanyName Microsoft Corporation**. This was read from the first 1 MiB without executing the installer.
- The `/latest/` URL is mutable. Replace it with an immutable versioned URL for the newly built, signed installer, as requested by the package form.
- Silent install switches are `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-`; successful-install return code is `0`, cancellation is `2`, and installer handling links to Inno Setup's exit-code documentation. These are configured values, not a completed Windows install test.
- **Properties → Product declarations → Notes for certification is empty.** The prepared notes above fit within the documented 2,000-character limit.
- The **generative AI** declaration is unchecked. This should be selected for Backboard Studio before resubmitting.
- Microsoft's package validation was initiated from **Packages → Run** and confirmed **In progress**. The portal estimates approximately **30 minutes**. [Open validation status](https://partner.microsoft.com/en-us/dashboard/win32apps/0f759939-60fe-4ebd-aacd-2084b297aaaa/submissions/draftsubmission/package-validation?packageid=98198417). A final result is not yet available; validation must be rerun after replacing the installer.

## Signed release verification — September 11, 2026, 22:14 UTC

- [Windows release run 34651320945](https://github.com/Backboard-io/Backboard-Desktop/actions/runs/34651320945) passed. It reuses the Azure-signed application from run 34636925501, source commit `d2c248ddc4351ba3521d32492225e949e87ad08b`. Only installer packaging was rebuilt, using Inno Setup 7.1.0 and installer source commit `4175ddc6`.
- The earlier Inno 6.4.1 user installer failed on a 262-character installation path. Inno 7 fixes that installation failure without rebuilding the application.
- Azure signatures were verified for 81 application binaries and both installers. The signer is Espri.ai Inc.
- Fresh user and system installs and uninstalls passed on a Windows Server 2022 CI runner. Installed Apps registered version **3.1.5**, publisher **Espri.ai**, and names **Backboard Studio (User)** and **Backboard Studio** respectively. Uninstall removed both registrations. This is CI evidence, not a manual Surface Laptop test.
- Release checks now cover fresh installations only. The 3.1.1 upgrade scenario was removed at the owner's request; no further upgrade check is required for this release.
- The reviewer API key returned HTTP 200 and an `OK` assistant response. Partner Center Properties now has the reviewer credentials/instructions saved and the generative AI declaration selected. These changes were reloaded and verified.
- Silent installation parameters: `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /MERGETASKS="!runcode"`.
- All signed release files are published and SHA-256 verified under `ide-releases/stable/3.1.5/bbide/windows-x86_64/` in the release bucket. The Windows stable manifest now points to 3.1.5. The Partner Center package URL has been replaced with the immutable 3.1.5 system installer URL; the package changes were saved and Microsoft package validation was initiated. Nothing has been resubmitted.

The earlier inspection sections above record historical state and are superseded by these verified updates.

## Submission cleanup and communication

- Simplified the saved certification notes to the dedicated test credentials, a short chat test, and uninstall instructions. Removed sign-out and Delete Account walkthrough details.
- Added uninstall instructions to the English Store description: Windows Settings → Apps → Installed apps (Apps & features on Windows 10) → Backboard Studio → Uninstall. This uses the working Windows uninstall entry already included in 3.1.5; no separate in-app uninstall button was added.
- Sent an urgent reply to the existing Microsoft certification conversation and a separate urgent review request to `reportapp@microsoft.com`. Both sends were confirmed by Gmail. The messages accurately state that the new package is prepared and ask for priority when resubmission is received.
- The portable ZIP is optional for this EXE/MSI Store submission. Its public download returned HTTP 200, size 536,170,025 bytes, SHA-256 `df7c864ed00406c2294fa303730b7f557552ae25eb86c730ee635bee4ab0fe40`. All 21,276 ZIP entries passed archive CRC verification.
- Remaining: inspect Microsoft's package-validation result, then resubmit the prepared draft. Microsoft approval is not yet granted.
