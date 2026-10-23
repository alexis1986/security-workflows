# security-workflows

Reusable GitHub Actions workflows (`on: workflow_call`) that add security checks
to a CI/CD pipeline: secret scanning, dependency scanning, SAST, IaC and image
scanning, SBOM and signing, and DAST.

All workflows share the same interface:

| Input | Default | Description |
|---|---|---|
| `mode` | `report` | `report` never fails on findings; `enforce` fails when there are blocking findings |
| `scan-path` | `.` | Path to scan |
| `upload-sarif` | `false` | Upload results to GitHub code scanning |

Outputs: `blocking-count` and `total-count`.

## Layers

| Layer | Workflow | Tool | Status |
|---|---|---|---|
| Secrets | `secrets.yml` | Gitleaks | Available |
| Dependencies (SCA) | `sca.yml` | Trivy | Available |
| SAST | `sast.yml` | Semgrep CE | Available |
| IaC | `iac.yml` | Trivy config | Planned |
| Image scan | `image-scan.yml` | Trivy image | Planned |
| SBOM and signing | `sign-sbom.yml` | Syft, cosign | Planned |
| DAST | `dast.yml` | OWASP ZAP | Planned |

## Usage

Call a workflow from a job in your repository. Every caller job must grant the
permissions below: the reusable workflows declare `security-events: write` (used
only for SARIF upload), and GitHub rejects a call whose caller grants less than
the called workflow requests, even when `upload-sarif` is `false`.

```yaml
jobs:
  secrets:
    permissions:
      contents: read
      security-events: write
    uses: alexis1986/security-workflows/.github/workflows/secrets.yml@main
    with:
      mode: report
      artifact-name: secrets-report
```

Additional input shared by all layers: `artifact-name` (default `<layer>-report`).
Use a distinct value per call when you call the same workflow more than once in a
run. The same value is used as the SARIF category, so two calls to one layer
(for example `backend/` and `frontend/`) never overwrite each other's code
scanning results. `secrets.yml` also accepts `config-path` (default: `.gitleaks.toml` at the
repository root when present; `none` uses the Gitleaks defaults); path inputs
must be relative to the repository root and must not contain `..`.

SARIF upload is skipped automatically on fork pull requests and Dependabot runs,
and a failed upload only emits a warning.

### Dependencies (SCA) with Trivy

```yaml
jobs:
  sca:
    permissions:
      contents: read
      security-events: write
    uses: alexis1986/security-workflows/.github/workflows/sca.yml@main
    with:
      mode: enforce
      upload-sarif: true
      artifact-name: sca-report
```

Scans the lockfiles and manifests under `scan-path` (pnpm, npm, Maven, ...).
Maven dependencies are resolved against public Maven Central only: parents and
BOMs from private repositories are not resolved, so the dependency list can be
incomplete. The workflow emits a warning when Trivy reports such problems, but
it cannot make the result complete. SARIF is produced from the same scan and
includes every severity, with paths relative to the repository root.
`blocking-count` is the number of CRITICAL or HIGH vulnerabilities that have a
fixed version available; `total-count` covers every severity. Exceptions go in
a `.trivyignore` inside `scan-path` or at the repository root (input
`ignore-path` selects another file, `none` disables it). Give every entry a
comment with the reason and an expiry, for example:

```
# no upgrade path yet; expires 2026-12-31
CVE-2021-23337 exp:2026-12-31
```

### SAST with Semgrep

```yaml
jobs:
  sast:
    permissions:
      contents: read
      security-events: write
    uses: alexis1986/security-workflows/.github/workflows/sast.yml@main
    with:
      mode: report
      rulesets: "p/typescript p/java p/owasp-top-ten"
```

Runs Semgrep Community Edition with the rule sources listed in `rulesets`
(registry packs or rule files in the repository; default `p/typescript p/java
p/owasp-top-ten`). `blocking-count` is the number of findings with severity
ERROR; `total-count` covers every severity (the SARIF includes every severity
too). A warning is emitted when Semgrep returns partial results. Exceptions go in a
`.semgrepignore` at the repository root, each with a comment stating the reason
and an expiry. Metrics are disabled.

More usage examples will be added as each layer lands.

## Maintenance

Dependabot keeps the pinned GitHub Actions up to date. These pins are not
tracked by Dependabot and must be bumped by hand:

- the Gitleaks image tag and digest (`GITLEAKS_IMAGE` in `secrets.yml`)
- the Trivy image tag and digest (`TRIVY_IMAGE` in `sca.yml`)
- the Semgrep image tag and digest (`SEMGREP_IMAGE` in `sast.yml`)
- the actionlint version (`lint.yml`)

## License

MIT
