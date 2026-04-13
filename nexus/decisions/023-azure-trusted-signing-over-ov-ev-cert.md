# ADR-023: Azure Trusted Signing Over OV/EV Certificate for Windows Code Signing
## Context

The Nexus Connector ships as a Windows executable via PyInstaller. An unsigned Windows executable downloaded from a website receives the maximum-severity SmartScreen warning: "Windows protected your PC." On Windows 11 with Smart App Control enabled (default for new installs since late 2022), unsigned apps are blocked outright with no user override. Every affected customer contacts support. Corporate IT deployments are entirely blocked.

The conventional advice is "buy a code signing certificate." Two tiers exist:

- **OV (Organization Validation)** certificates (~$200-400/year). Signed executables still show a SmartScreen warning because OV certs provide no instant reputation -- reputation builds organically over time as users click "run anyway." For a small-volume distribution (dozens of downloads per year, not millions), organic reputation never arrives.

- **EV (Extended Validation)** certificates (~$300-500/year), requiring a hardware USB token. Historically these provided instant SmartScreen bypass. In March 2024, Microsoft changed the policy. EV certificates no longer provide instant reputation. New binaries signed with EV certs now go through the same organic reputation process as OV-signed binaries. The only difference is the EV cert costs more and requires hardware token management.

This policy change invalidated the standard advice. Most guidance online is still based on the pre-2024 world.

## Decision

**Use Azure Trusted Signing** ($9.99/month, or $120/year) for Windows code signing. Azure Trusted Signing is Microsoft's own cloud signing service, and signatures from it provide instant SmartScreen reputation -- because they come from Microsoft. It is the successor pattern to the old EV-instant-bypass that Microsoft's policy change left a gap in.

**Also use Apple Developer Program** ($99/year) for macOS code signing and notarization (required since Catalina). Total annual cost for dual-platform signing: **$219/year**.

Code signing is wired into the build pipeline as a post-build step. `signtool` (Windows) and `codesign` + `xcrun notarytool` (macOS) run after PyInstaller finishes bundling, before the distributable is uploaded.

**UPX compression is explicitly disabled** in the PyInstaller spec (`bootstrapper.spec`: `upx=False`). UPX-packed binaries trigger AV false positives because malware authors frequently use UPX. UPX is a separate problem from signing and has to be addressed independently.

## Alternatives Considered

- **Traditional EV certificate.** What most guidance recommends because the old advice has not been updated. Rejected because the March 2024 policy change invalidated it -- EV certificates no longer provide instant reputation.

- **OV certificate + organic reputation building.** Would work for a high-download-volume app. Nexus Connector has dozens of downloads per year, which is not enough to build organic reputation. Months or years of warnings before reputation accrues.

- **Self-signed certificate.** Self-signed certs are treated as untrusted by Windows. Worse than unsigned in some ways.

- **MSIX packaging.** Would bypass SmartScreen warnings for apps installed through the Microsoft Store. Rejected because installing a line-of-business app through the Store is high-friction for customers (account required, installation complexity). Direct download is the preferred distribution model.

- **Don't sign at all -- tell customers to click "More info -> Run anyway."** Tried. Customers called support every single time.

## Consequences

**Good:**
- Azure Trusted Signing provides instant SmartScreen reputation. Customers download the signed Nexus Connector and get no warning. Support call volume drops to zero for this specific problem.
- The signing service is managed -- no hardware token to lose, no HSM to maintain, no certificate renewal ceremony. Private key lives in Azure.
- Total cost is $219/year for both Windows and macOS. Cheaper than the OV+EV alternative.
- The build pipeline becomes authoritative. Every release gets signed as part of the build script -- no "oops, forgot to sign" releases.

**Bad / costs:**
- Azure Trusted Signing requires an Azure subscription and an associated tenant. Operational overhead to set up and maintain.
- Signing is a build-time step. A compromised build machine could sign a malicious binary. Mitigated by restricting build machine access and by the fact that Nexus Connector builds are infrequent.
- The macOS side requires Apple Developer Program enrollment, which has its own approval process and ongoing requirements.
- If Microsoft changes the policy again or deprecates Azure Trusted Signing, this decision needs revisiting. Microsoft-owned signing infrastructure has better odds of long-term viability than a third-party CA, but nothing is guaranteed.

In March 2024, Microsoft changed SmartScreen's reputation policy. EV certificates no longer provide instant reputation bypass. Azure Trusted Signing does. Most online guidance (blog posts, Stack Overflow) predates this policy change and still recommends EV certificates.
