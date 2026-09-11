# Backboard Studio — Microsoft Store readiness audit

Assessment date: September 11, 2026. Target: Windows desktop, EXE/MSI submission, proposed release 3.1.5.

**Verdict: eligible in principle; not ready to resubmit.** The IDE’s product type is compatible with the Store. There are confirmed submission/build blockers and additional product risks. This is an evidence-based readiness assessment, not a Microsoft certification result.

Microsoft accepts traditional Windows installers; converting this IDE to MSIX is not necessary for this submission. Its EXE route requires a signed standalone installer, signed PE payloads, silent installation, and an immutable versioned HTTPS download. [Package requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements).

**Evidence and limits**

- Inspected current working-tree source at HEAD `b1ea491f6509e97bcec2299bd28753cf29c57ac9`, including uncommitted fixes. This checkout is being edited; this document describes the inspected snapshot.
- Rechecked current Microsoft documentation and the Windows release workflow’s latest three runs; all three were failures.
- Rechecked the submitted installer URL: HTTP 200, 393,991,112 bytes, last modified September 6, 2026. Earlier in this session its PE header identified version 3.1.1 and CompanyName Microsoft Corporation.
- Used the earlier same-day Partner Center inspection recorded in [certification notes](./MICROSOFT_STORE_CERTIFICATION_NOTES.md). Portal fields and the final validation result were not re-read during this audit. Do not treat those earlier observations as a new live portal check.
- Opened the configured privacy URL in a fresh browser session: it redirected to the Backboard sign-in page.
- Previous local checks covered reviewer access, credential clearing, onboarding, tour geometry and SSO routing. Those tests and the earlier successful API request are useful evidence, but not tests of a signed Windows release. No new Windows installation, Defender scan, real SSO approval, account deletion, or Store submission was performed here.

**What reviewers examine and where this IDE stands**

Microsoft’s published certification process covers package access, malware, silent installation, standard-user installation, Start-menu registration, uninstall metadata/cleanup, offline setup, unrelated bundled software, dependencies, privacy and runtime reliability. [Certification process](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-certification-process).

| Review area | Evidence/status for Backboard | Required next evidence or action |
|---|---|---|
| Product identity | **Known rejection; source correction only.** Installer metadata now uses Espri.ai, matching the earlier portal report. Hosted installer remains old. | Inspect Installed Apps and PE metadata from the rebuilt artifact. |
| Reviewer access | **Known rejection; submission incomplete at last inspection.** Certification notes field was empty. Demo sign-in exists locally. | Paste tested credentials/instructions into Partner Center; keep access funded throughout review. |
| Release artifact | **Blocked.** No successful latest Windows workflow run; no validated 3.1.5 artifact. | Fix packaging failure and build a reproducible signed release. |
| Download URL | **Reachable, unsuitable release practice.** Current URL contains `/stable/latest/`. | Host 3.1.5 at a new immutable URL; never overwrite that object. |
| Signatures | **Implemented pipeline, unverified output.** Azure signing and recursive verification are configured. | Pass verification on the installer, application, helpers, native modules and uninstaller. |
| Installation | **Configured, not exercised.** Inno Setup includes bundled files and silent switches are recorded. | Test the exact portal command on clean Windows under a standard user. |
| Privileges | **Needs Windows check.** System installer is the submitted flavor; per-user flavor explicitly uses lowest privileges. | Validate elevation, installation ownership and first launch; consider per-user installer if it better fits distribution. |
| Removal/upgrade | **Unverified.** Uninstall directives exist; no full fresh-install/upgrade/uninstall trace. | Check files, shortcuts, registry entries, services/processes and retained account data. Preserve user projects. |
| Privacy access | **Confirmed product link problem.** Configured chat privacy URL opens login; top-level product privacy URL is absent. | Use a public policy URL in app and Partner Center. |
| AI declaration/reporting | **High rejection risk.** AI checkbox was unchecked at last inspection; no Backboard-specific reporting destination found. | Declare AI and implement/test a report route that reaches the developer. |
| Customer authentication | **Confirmed UX mismatch.** Email/password form only accepts a hardcoded demo pair. | Use real account authentication, or make SSO the clearly explained normal route. |
| Secrets/account isolation | **Release security risk.** A live reviewer key is embedded in renderer source. | Replace with a restricted server-authenticated demo account; verify account isolation and quotas. |
| Sign out | **Source tested; Windows scope unverified.** Removes file/config credentials and restarts the agent host. | Check every chat surface, restart, another window, and environment-provided credentials. |
| Delete Account | **Navigation only.** Opens dashboard root. | Confirm a discoverable working deletion path there using a disposable account. |
| Core workflows | **Partially evidenced.** Local chat/API and UI checks passed earlier. | Run file editing, command execution, tools, cancellation and persistence on Windows. |
| Updates | **Windows manual download route.** Update action opens the installer URL; in-app installation is macOS-only. | Test Windows download/upgrade and keep Store package URL current. |
| Listing/pricing/ratings | **Not fully audited live.** Actual screenshots, rating answers, pricing and dependency text still need review. | Match the tested product, account/network requirements and any paid AI usage. |
| Accessibility/scaling | **Partial local evidence.** Prior tour/control sizing tests; no Windows accessibility pass. | Keyboard-only, Narrator, high contrast and 125–200% scale checks. |
| Licensing/extensions | **Unverified.** Open VSX is configured; Copilot/third-party SDK payloads are bundled. | Audit redistribution rights and notices for the exact shipped files. |
| Platform support | **x64 pipeline only.** Installer minimum is Windows 10; native headers/runtime versions differ. | Test claimed OS versions and architectures; align Electron 42.3.0 headers with packaged 42.2.0 or justify compatibility. |

Store policy sections relevant here include accurate representation (10.1), security/removal (10.2), test accounts and server availability (10.3), usability (10.4), personal information (10.5), transactions (10.8), third-party content (11.2), ratings (11.11), and generative AI (11.16). AI products need disclosure, a Partner Center declaration, compliant output and a developer reporting channel. [Store policies](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies).

**Findings that should be addressed before resubmission**

1. **The reviewer would still receive the old package.** The existing hosted installer is not the locally edited application. The two reported failures were 10.2.7 (Name/Publisher) and 10.3.1 (test account). A corrected source tree and a local notes document do not change the submitted binary or form fields. Evidence: earlier portal report linked in the certification notes; current installer response headers.

2. **The Windows build is failing before certification testing can begin.** The [latest run](https://github.com/Backboard-io/Backboard-Desktop/actions/runs/34009200819) failed when `rcedit` tried to patch a macOS ARM native module under `@anthropic-ai/claude-agent-sdk/vendor/audio-capture/arm64-darwin/audio-capture.node`. `backboard/build/gulpfile.vscode.ts:578` still selects native modules without checking executable format. Its dependency metadata also still assigns Microsoft Corporation. Prune incompatible vendor payloads or validate file format before patching, then verify every actual shipped Windows PE. Do not simply bypass signature failures.

3. **The privacy link is not a public policy page.** `backboard/product.json:114` points chat users at `https://app.backboard.io/privacy`; the browser reached the login screen. The generic Help privacy action also depends on a top-level `privacyStatementUrl`, which is absent. A public [Backboard privacy policy](https://backboard.io/privacy-policy) does exist and discusses user content, files, AI routing and deletion requests. Wire the correct public location consistently. Review whether its statements accurately cover desktop prompts, selected files, persistent memory, voice, screenshots, telemetry and third-party tools; that coverage has not been legally verified here.

4. **AI reporting is not demonstrated.** `backboard/product.json:40` has an empty `reportIssueUrl`. Generic inherited chat reporting in `chatTitleActions.ts:126` is conditional; I found no Backboard registration for response issue-reporting support in the inspected extension/CLI paths. No equivalent report action was found in the custom panel. Add a clear report action to generated responses that sends only user-approved details to a monitored Backboard destination. Test receipt and establish handling responsibility. A generic inherited menu or a thumbs-down count is not evidence that reports reach your team.

5. **The requested reviewer shortcut should not become public authentication.** `onboardingVariationA.ts:828` renders a normal-looking email/password form, but line 860 rejects every pair except the reviewer constants. Line 868 installs the embedded API key. This makes the ordinary form misleading and distributes a reusable credential in readable application code. Earlier implementation followed the requested hardcoding; for public distribution, I recommend replacing it. Use a restricted demo tenant with server-side authentication, explicit quotas and no production customer data. Keep its behavior representative of the shipped product; document demo limitations honestly. No proof of server-side tenant isolation or spending limits was available in this audit.

6. **Sign-out and account deletion need accurate claims.** The local sign-out implementation clears several credential stores, but the CLI can also read `BACKBOARD_API_KEY` from the process environment. A restart can inherit that value again. The Delete Account action at `backboardSsoActions.ts:100` only opens `https://app.backboard.io`; it does not itself delete an account. Test the complete web path before claiming deletion works. Do not delete the shared certification account for this test. I did not identify a blanket Store requirement for a particular native Delete Account button; this is a product promise and privacy-control verification issue.

7. **A Windows-specific execution path warrants testing.** The extension fallback builds Python/Node command strings with POSIX quoting (`backboardExtension.ts:3284`, `:4133`) and runs them with `shell: true` (`:3232`). Windows normally uses a different shell, and clean machines may lack `python3` or Node. This is a source-level compatibility risk, not a confirmed failure of the bundled CLI path. Exercise the path that reviewers actually receive; avoid advertising unsupported tools or silently relying on the developer’s machine setup.

8. **Silent setup may launch the IDE.** Inno’s `runcode` task is available during silent setup and its run entry can launch the application (`code.iss:93`, `:118`, `:1494`). Verify the submitted command produces the expected silent behavior on a fresh install and upgrade. If the IDE launches unexpectedly, explicitly suppress that task for Store installs. This is a test candidate, not a claim that its current behavior has failed certification.

**What already helps**

The repository has a dedicated Windows x64 CI workflow, a bundled CLI build, stable/sandbox metadata stamping, separate user/system installers, Azure signing, a signer-subject verification gate and SHA-256 output. Source changes address the known publisher issue and add reviewer access, SSO, sign out and onboarding improvements. The public API responded successfully in the earlier session. These are useful foundations, not substitutes for testing the release artifact.

Keeping EXE/MSI for 3.1.5 is my recommendation because the current installer and submission already use that route. Store-managed updates are not provided for this route; the app/installer handles them. [Distribution comparison](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/choose-distribution-path). In this repo the Windows update action opens a download rather than performing the macOS automatic replacement flow. Describe and test that actual behavior.

**Proposed Windows acceptance run**

Run these against one frozen installer hash, from a clean VM snapshot, and preserve screenshots/logs with that hash. This is my test plan for this IDE, not Microsoft’s undisclosed internal test suite.

| Scenario | Acceptance evidence |
|---|---|
| Fresh setup | Standard Windows user; no developer tools; exact silent command; exit code, elevation behavior, Start-menu entry and first launch recorded. |
| Identity/signing | Installed Apps shows Backboard Studio and Espri.ai; version 3.1.5; signature trust and timestamps pass throughout payload. |
| Reviewer route | Fresh profile → supplied credentials → Simple mode → tour → chat response → create/edit a disposable project file. No OTP or payment step for the demo route. |
| Real customer route | SSO and signup work; cancel/deny/timeout are recoverable; account state appears consistently in Chat and Agents. |
| Tools | Terminal, paths containing spaces/non-ASCII, file diff/apply/revert, tool approval/cancel and missing-runtime messages work. |
| Account controls | Sign out prevents authenticated requests in every window and after restart; signing into another account does not expose prior private content. Web deletion works on a disposable account. |
| Network/API faults | Offline launch, interrupted requests, expired key, quota exhausted and service errors leave the UI responsive with useful recovery. |
| Layout/accessibility | 1366×768 and high-DPI laptop; 125/150/200% scaling; keyboard navigation, focus, Narrator; all onboarding and tour controls reachable. |
| Lifecycle | Close/relaunch, sleep/resume, cancelled setup and upgrade from submitted 3.1.1 preserve projects and avoid duplicate product entries. |
| Removal | Uninstall clears installed binaries/integrations and terminates owned background processes; retained personal data is intentional and controllable. |
| Security/content | Defender scan; credential/log review; AI reporting receipt; consent for microphone, screenshots and third-party tools. |
| Release delivery | Download hash matches tested file; update points to correct channel/architecture; Partner Center validates the new package. |

Testing Windows on the Mac’s ARM VM can be useful, but also run the x64 installer on Windows x64 to match the current release target. Use the existing Windows CI runner for building/signing; a clean Windows desktop VM supplies the interactive verification that CI compilation lacks.

**Submission gate**

Before submitting, I would require all confirmed blockers above resolved, the acceptance run recorded, and the final Partner Center draft reviewed. Check category, pricing, ratings, accurate Windows screenshots, license terms, support/privacy links, AI declaration, system requirements and certification notes. The notes field has a 2,000-character limit. [Submission fields](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/create-app-submission).

Commit the intended source, build/sign 3.1.5, test it, host that exact artifact at an immutable URL, update the draft and rerun package validation. Final submission should use that tested artifact. The present evidence supports **“can become eligible for approval after fixes and Windows verification,” not “ready” or “guaranteed to pass.”**
