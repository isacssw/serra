# Releasing Serra

For the maintainer. Releases are cut in CI from `main`, which is protected, so a release is a PR like any other change.

## Versions and the changelog

- `package.json`'s `version` is the last released version. The app shows it, and the `.dmg` is named after it.
- `CHANGELOG.md` keeps merged, unreleased changes under `## Unreleased`. Add a line there in each PR a user would notice.
- Tags are `v<version>`, like `v0.1.0-alpha.2`. A version with a `-` (alpha, beta, rc) is published as a prerelease; one without is marked the latest release.

## Cutting a release

1. **Actions › Release: prepare › Run workflow**, on `main`, with the new version (no `v`). It raises `package.json`, turns `## Unreleased` into `## <version> (<date>)`, pushes the branch `chore/release-v<version>` and opens a release PR titled `chore(release): v<version>`. It also starts CI on that branch.
2. Review the PR. Edit `CHANGELOG.md` on the branch to change the notes. Merge it (squash).
3. The merge starts **Release: publish**. It sees that the push raised the version, runs the checks and tests again, builds the app on macOS, smoke-tests it, then tags the merge commit `v<version>` and publishes a GitHub Release with the changelog section as notes, the `.dmg` and `SHA256SUMS`.

If publishing fails after the merge, fix the cause and run **Release: publish** by hand on `main`. It publishes the version in `package.json` if that tag doesn't exist yet.

Every PR and every push to `main` also builds the app (CI's `app` job), and keeps the `.dmg` as a run artifact for a week.

## Signing and notarization

Without secrets, release builds are ad-hoc signed, like `pnpm app:package`, and users open them past Gatekeeper once ([install](app/install.md)). The publish workflow signs and notarizes once these secrets are in the repository's `release` environment (**Settings › Environments › release**):

| Secret | What |
|---|---|
| `CSC_LINK` | The Developer ID Application certificate and key, exported as `.p12` and base64-encoded |
| `CSC_KEY_PASSWORD` | The `.p12` password |
| `APPLE_API_KEY` | The contents of an App Store Connect API key (`AuthKey_….p8`) |
| `APPLE_API_KEY_ID` | That key's ID |
| `APPLE_API_ISSUER` | The issuer ID from App Store Connect › Users and Access › Integrations |

Add them only through GitHub's settings pages. Never paste them into an issue, a PR, a chat or a file in the repository.
