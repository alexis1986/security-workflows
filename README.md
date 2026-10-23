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
| IaC | `iac.yml` | Trivy config | Available |
| Image scan | `image-scan.yml` | Trivy image | Available |
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

### IaC with Trivy

```yaml
jobs:
  iac:
    permissions:
      contents: read
      security-events: write
    uses: alexis1986/security-workflows/.github/workflows/iac.yml@main
    with:
      mode: enforce
      upload-sarif: true
      scan-path: deploy
      helm-chart: deploy/chart   # optional
      artifact-name: iac-report
```

Scans Dockerfiles, Kubernetes manifests, Terraform and CloudFormation under
`scan-path` (a directory) with `trivy config`. Misconfigurations have no "fixed
version", so `blocking-count` is the number of CRITICAL or HIGH findings;
`total-count` covers every severity. With `helm-chart`, the chart is rendered
with `helm template` (default values; dependencies must be vendored) and the
rendered manifests are scanned too, reported against the chart path (the chart
directory is excluded from the main scan, so findings are counted once; line
numbers refer to the rendered manifest, not the template). Exceptions
go in a `.trivyignore` (`ignore-path` works as in the SCA layer), each with a
comment stating the reason and an expiry.

### Container image with Trivy

`image-scan.yml` builds the image, scans it and, with `push: true`, pushes that
same image. Nothing is rebuilt: the image that was scanned (checked by image ID)
is tagged with each entry of `push-tags` and pushed, and only after the policy
step passed. In `enforce` mode a blocking finding fails the job before any push;
in `report` mode the image is pushed regardless of findings. The pushed image
therefore cannot differ from the scanned one. Callers must grant
`contents: read`, `security-events: write` and `packages: write` (the push logs
in to `ghcr.io` with the job token; other registries are not supported).

```yaml
jobs:
  image-scan:
    permissions:
      contents: read
      security-events: write
      packages: write
    uses: alexis1986/security-workflows/.github/workflows/image-scan.yml@main
    with:
      mode: enforce
      upload-sarif: true
      context: .
      dockerfile: Dockerfile
      image-name: my-app
      artifact-name: image-report
      push: true
      push-tags: |
        ghcr.io/<owner>/my-app:latest
        ghcr.io/<owner>/my-app:sha-${{ github.sha }}
    secrets:
      build-args: |
        VITE_API_KEY=${{ secrets.VITE_API_KEY }}

  sign:
    needs: image-scan
    # ... pass needs.image-scan.outputs.digest to sign-sbom
```

Outputs besides the counts: `image-id` (ID of the scanned image) and `digest`
(repo digest of the pushed image, empty when nothing was pushed). Pass
`needs.image-scan.outputs.digest` to the signing and SBOM job. `push-tags`
entries must be full lowercase references with a tag (`registry/repo:tag`).

The image is built with `push: false` and `load: true`, exported to a tarball and
scanned with `trivy image --input` (the Docker socket is never mounted into the
scanner). The build cache (`type=gha`, scope `image-name`) is a best-effort speed
optimisation; correctness does not depend on it. `blocking-count` is the number
of CRITICAL or HIGH vulnerabilities that have a fixed version available;
`total-count` covers every severity. In the SARIF every alert is attached to the
Dockerfile, since image findings have no source location. The optional secret
`build-args` takes multiline `KEY=VALUE` build arguments; it is masked and never
echoed. Build arguments end up in the image history, so keep truly confidential
values out of them (use BuildKit secret mounts). Fork pull requests do not
receive secrets, so their build runs without `build-args`. `context` defaults to
`scan-path`; `dockerfile` defaults to `<context>/Dockerfile`.

## Maintenance

Dependabot keeps the pinned GitHub Actions up to date. These pins are not
tracked by Dependabot and must be bumped by hand:

- the Gitleaks image tag and digest (`GITLEAKS_IMAGE` in `secrets.yml`)
- the Trivy image tag and digest (`TRIVY_IMAGE` in `sca.yml`, `iac.yml` and `image-scan.yml`)
- the Helm version used to render charts (`version` of `azure/setup-helm` in `iac.yml`)
- the Semgrep image tag and digest (`SEMGREP_IMAGE` in `sast.yml`)
- the actionlint version (`lint.yml`)

## License

MIT
