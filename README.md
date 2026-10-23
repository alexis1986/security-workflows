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

Usage examples will be added as each layer lands.

## License

MIT
