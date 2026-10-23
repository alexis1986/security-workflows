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
| Dependencies (SCA) | `sca.yml` | Trivy | Planned |
| SAST | `sast.yml` | Semgrep CE | Planned |
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
run. `secrets.yml` also accepts `config-path` (default: `.gitleaks.toml` at the
repository root when present; `none` uses the Gitleaks defaults).

SARIF upload is skipped automatically on fork pull requests and Dependabot runs,
and a failed upload only emits a warning.

More usage examples will be added as each layer lands.

## Maintenance

Dependabot keeps the pinned GitHub Actions up to date. These pins are not
tracked by Dependabot and must be bumped by hand:

- the Gitleaks image tag and digest (`GITLEAKS_IMAGE` in `secrets.yml`)
- the actionlint version (`lint.yml`)

## License

MIT
