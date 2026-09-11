# Microsoft Store certification

## Paste into Properties → Notes for certification (under Product declarations)

Backboard Studio includes an email/password sign-in for the certification test account:

- Email: bburgers784@gmail.com
- Password: password123!

Testing instructions:

1. Install and launch Backboard Studio with an internet connection.
2. In the onboarding sign-in form, enter the credentials above and choose **Sign In**. Account creation, an email verification code, and browser SSO are not required for this test account.
3. Onboarding opens Simple mode and starts the guided tour. Use Continue to advance through the tour, or Skip to close it.
4. Enter a short prompt in chat, such as “Explain what this IDE can help me build.” Wait for the assistant's reply. You can open a project folder to test file editing and other project features.
5. If onboarding was skipped, choose **Sign In** from the title bar, Agents page, or chat sign-in panel, and use the same credentials.
6. Open Settings → Commonly Used. **Sign Out** removes saved API keys and SSO credentials from this device. The same action is available in the Manage (gear) menu directly below **Check for Updates**. Sign in again using the credentials above to resume testing.
7. **Delete Account** in Settings → Commonly Used opens the Backboard web dashboard, where account deletion is managed. Do not delete the shared certification test account while evaluating other features.

The Windows installer identifies the product as **Backboard Studio** (**Backboard Studio (User)** for a per-user installation) and the publisher as **Espri.ai**.

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
