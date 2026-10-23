# security-workflows

Reusable GitHub Actions workflows (`on: workflow_call`) that add security checks
to a CI/CD pipeline, one workflow per layer: secret scanning, dependency
scanning (SCA), SAST, IaC and container image scanning, SBOM generation with
image signing, and DAST. Each workflow is self-contained, pins every third-party
action by commit SHA and every tool image by tag and digest, and reports the same
way: a job summary table, a raw report artifact and numeric outputs.

> Resumen en español al final de este documento.

## Layers

| Layer | Workflow | Tool | Blocking policy (`enforce`) |
|---|---|---|---|
| Secrets | `secrets.yml` | Gitleaks | Any secret, in the full history |
| Dependencies (SCA) | `sca.yml` | Trivy `fs` | CRITICAL/HIGH with a fix available |
| SAST | `sast.yml` | Semgrep CE | Severity ERROR |
| IaC | `iac.yml` | Trivy `config` | CRITICAL/HIGH |
| Image scan | `image-scan.yml` | Trivy `image` | CRITICAL/HIGH with a fix available |
| SBOM and signing | `sign-sbom.yml` | Syft, cosign | Any failure fails the job (no report mode) |
| DAST | `dast.yml` | OWASP ZAP baseline | High-risk alerts |

## Common interface

Every scanning workflow exposes the same interface:

| Input | Default | Description |
|---|---|---|
| `mode` | `report` | `report` never fails on findings; `enforce` fails when there are blocking findings |
| `scan-path` | `.` | Path to scan (not available in `dast.yml`, `sign-sbom.yml`) |
| `upload-sarif` | `false` | Upload results to GitHub code scanning (not available in `dast.yml`, `sign-sbom.yml`) |
| `artifact-name` | `<layer>-report` | Name of the report artifact; also the SARIF category. Use a distinct value per call when the same workflow runs more than once |

Outputs: `blocking-count` and `total-count` (numeric strings). `image-scan.yml`
also outputs `image-id` and `digest`.

Path inputs must be relative to the repository root and must not contain `..`.
Every workflow validates its inputs strictly before doing anything else.

Each run writes a Markdown table to the job summary (tool, severity, count, top 10
findings) and uploads the raw report as an artifact. A report that is missing or
malformed always fails the job: a workflow never returns `blocking-count=0`
because a tool silently produced nothing.

## Required caller permissions

GitHub rejects a call whose caller grants less than the called workflow requests,
even for features that are switched off (for example `upload-sarif: false`), so
every caller job must grant the permissions of the layer it calls:

| Workflow | `contents` | `security-events` | `packages` | `id-token` |
|---|---|---|---|---|
| `secrets.yml`, `sca.yml`, `sast.yml`, `iac.yml` | read | write | | |
| `image-scan.yml` | read | write | write | |
| `sign-sbom.yml` | read | | write | write |
| `dast.yml` | read | | | |

`security-events: write` is used only for SARIF upload (skipped automatically on
fork pull requests and Dependabot runs; a failed upload only emits a warning).
`packages: write` is used to push to ghcr.io. `id-token: write` is used for
keyless signing; it must be granted even with `signing: key`.

## Blocking policy

`mode: report` (the default) never fails on findings. `mode: enforce` fails the
job when `blocking-count` is greater than zero:

- Secrets: any finding. Gitleaks scans the full git history and redacts values.
- SCA, image: CRITICAL or HIGH vulnerabilities that have a fixed version
  (equivalent to `trivy --ignore-unfixed`). `total-count` covers all severities.
- SAST: Semgrep findings with severity ERROR.
- IaC: CRITICAL or HIGH misconfigurations.
- DAST: High-risk ZAP alerts.
- Signing: no report mode; a failed signature or attestation fails the job.

## Quick start

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

## Adoption model: report, then enforce

1. Add every layer with `mode: report` and read the job summaries for a few runs.
   Nothing fails, so the pipeline keeps its current behaviour.
2. Fix real findings, and record the justified ones as time-boxed exceptions
   (see below).
3. Switch each layer to `mode: enforce` once its `blocking-count` is zero, one
   layer at a time, and make the job a required check on the protected branch.
4. Keep the exceptions short-lived: an expired entry is a finding to revisit.

## Layers in detail

### Secrets with Gitleaks

Scans the full git history (`scan-path: .`, or a directory otherwise). Findings
are redacted in logs, in the summary and in the report. Configuration comes from
`config-path` (default: `.gitleaks.toml` at the repository root when present;
`none` uses the Gitleaks defaults). Exceptions go in `.gitleaksignore`.

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
incomplete. The workflow emits a warning when Trivy reports such problems, but it
cannot make the result complete. SARIF is produced from the same scan and
includes every severity, with paths relative to the repository root. Exceptions
go in a `.trivyignore` inside `scan-path` or at the repository root (input
`ignore-path` selects another file, `none` disables it).

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
p/owasp-top-ten`). The SARIF includes every severity. A warning is emitted when
Semgrep returns partial results. Exceptions go in a `.semgrepignore` at the
repository root. Metrics are disabled.

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
version", so `blocking-count` is the number of CRITICAL or HIGH findings. With
`helm-chart`, the chart is rendered with `helm template` (default values;
dependencies must be vendored) and the rendered manifests are scanned too,
reported against the chart path (the chart directory is excluded from the main
scan, so findings are counted once; line numbers refer to the rendered manifest,
not the template). Exceptions go in a `.trivyignore` (`ignore-path` works as in
the SCA layer).

### Container image with Trivy

`image-scan.yml` builds the image, scans it and, with `push: true`, pushes that
same image. Nothing is rebuilt: the image that was scanned (checked by image ID)
is tagged with each entry of `push-tags` and pushed, and only after the policy
step passed. In `enforce` mode a blocking finding fails the job before any push;
in `report` mode the image is pushed regardless of findings. The pushed image
therefore cannot differ from the scanned one. The push logs in to `ghcr.io` with
the job token; other registries are not supported.

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
```

Outputs besides the counts: `image-id` (ID of the scanned image) and `digest`
(repo digest of the pushed image, empty when nothing was pushed). `push-tags`
entries must be lowercase `ghcr.io/<owner>/<repo>:<tag>` references.

The image is built with `push: false` and `load: true`, exported to a tarball and
scanned with `trivy image --input` (the Docker socket is never mounted into the
scanner). The build cache (`type=gha`, scope `image-name`) is a best-effort speed
optimisation; correctness does not depend on it. In the SARIF every alert is
attached to the Dockerfile, since image findings have no source location. The
optional secret `build-args` takes multiline `KEY=VALUE` build arguments; it is
masked and never echoed. Build arguments end up in the image history, so keep
truly confidential values out of them (use BuildKit secret mounts). Fork pull
requests do not receive secrets, so their build runs without `build-args`.
`context` defaults to `scan-path`; `dockerfile` defaults to `<context>/Dockerfile`.

### SBOM and signing with Syft and cosign

`sign-sbom.yml` generates a CycloneDX SBOM of an image with Syft (uploaded as the
`sbom` artifact), signs the image with cosign and attaches the SBOM as a signed
attestation (`cosign attest --type cyclonedx`).

```yaml
jobs:
  sign:
    needs: image-scan
    permissions:
      contents: read
      packages: write
      id-token: write
    uses: alexis1986/security-workflows/.github/workflows/sign-sbom.yml@main
    with:
      image-ref: ghcr.io/<owner>/my-app@${{ needs.image-scan.outputs.digest }}
      signing: keyless
```

| Input | Default | Description |
|---|---|---|
| `image-ref` | required | `ghcr.io/<owner>/<repo>@sha256:<digest>`. Signing by tag is rejected: a signature must be bound to immutable content |
| `signing` | `keyless` | `keyless` (GitHub OIDC) or `key` (secrets `cosign-private-key`, `cosign-password`) |
| `tlog-upload` | `true` | Record signatures in the public Rekor log. `false` is only allowed with `signing: key` |
| `artifact-name` | `sbom` | Name of the SBOM artifact |

Signing modes:

- `keyless`: no key to manage. The signature is bound to the workflow identity
  through a short-lived certificate and recorded in the public Rekor
  transparency log.
- `key`: the secrets are passed to cosign through environment variables
  (`--key env://COSIGN_PRIVATE_KEY`); the key is never written to disk or echoed.

```yaml
    with:
      image-ref: ghcr.io/<owner>/my-app@${{ needs.image-scan.outputs.digest }}
      signing: key
      tlog-upload: false          # private repositories
    secrets:
      cosign-private-key: ${{ secrets.COSIGN_PRIVATE_KEY }}
      cosign-password: ${{ secrets.COSIGN_PASSWORD }}
```

Public transparency log: Rekor is public, so a keyless signature or a key
signature with `tlog-upload: true` publishes the repository and image identity.
For private repositories use `signing: key` with `tlog-upload: false`: nothing is
uploaded to Rekor and verification needs `--insecure-ignore-tlog=true` (see
below). Signing failures always fail the job.

### DAST with OWASP ZAP

```yaml
jobs:
  dast:
    permissions:
      contents: read
    uses: alexis1986/security-workflows/.github/workflows/dast.yml@main
    with:
      mode: report
      target-url: https://staging.example.com
      rules-file: .zap/rules.tsv   # optional
```

Runs the ZAP baseline scan (passive: it spiders the target and reports what it
observes) through `zaproxy/action-baseline` with `fail_action: false` and
`allow_issue_writing: false`; the policy is applied by this workflow. Only scan
targets you own or are authorised to test. `target-url` must be an `https` URL
without credentials. `blocking-count` is the number of High-risk alerts;
`total-count` covers every risk level. A scan that cannot reach the target or
writes no report fails the job. The optional `rules-file` is a ZAP rules file
(tab-separated: rule id, `IGNORE`/`INFO`/`WARN`/`FAIL`, comment).

## Pipeline examples

### Node pipeline

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:

jobs:
  secrets:
    permissions: { contents: read, security-events: write }
    uses: alexis1986/security-workflows/.github/workflows/secrets.yml@main
    with: { mode: enforce }

  sca:
    permissions: { contents: read, security-events: write }
    uses: alexis1986/security-workflows/.github/workflows/sca.yml@main
    with: { mode: enforce, upload-sarif: true }

  sast:
    permissions: { contents: read, security-events: write }
    uses: alexis1986/security-workflows/.github/workflows/sast.yml@main
    with: { mode: report, upload-sarif: true }

  iac:
    permissions: { contents: read, security-events: write }
    uses: alexis1986/security-workflows/.github/workflows/iac.yml@main
    with: { mode: enforce, scan-path: deploy }

  image-scan:
    needs: [secrets, sca, sast, iac]
    if: github.event_name == 'push'
    permissions: { contents: read, security-events: write, packages: write }
    uses: alexis1986/security-workflows/.github/workflows/image-scan.yml@main
    with:
      mode: enforce
      image-name: web
      push: true
      push-tags: |
        ghcr.io/<owner>/web:latest
        ghcr.io/<owner>/web:sha-${{ github.sha }}

  sign:
    needs: image-scan
    permissions: { contents: read, packages: write, id-token: write }
    uses: alexis1986/security-workflows/.github/workflows/sign-sbom.yml@main
    with:
      image-ref: ghcr.io/<owner>/web@${{ needs.image-scan.outputs.digest }}

  dast:
    needs: sign
    permissions: { contents: read }
    uses: alexis1986/security-workflows/.github/workflows/dast.yml@main
    with:
      mode: report
      target-url: https://staging.example.com
```

### Java pipeline with a matrix of services

A job that calls a reusable workflow can have its own `matrix`, so each service gets its own scan and a distinct artifact name:

```yaml
jobs:
  secrets:
    permissions: { contents: read, security-events: write }
    uses: alexis1986/security-workflows/.github/workflows/secrets.yml@main
    with: { mode: enforce }

  scan:
    strategy:
      fail-fast: false
      matrix:
        service: [orders, billing]
    permissions: { contents: read, security-events: write }
    uses: alexis1986/security-workflows/.github/workflows/sca.yml@main
    with:
      mode: enforce
      scan-path: services/${{ matrix.service }}
      artifact-name: sca-report-${{ matrix.service }}

  sast:
    permissions: { contents: read, security-events: write }
    uses: alexis1986/security-workflows/.github/workflows/sast.yml@main
    with: { mode: report, upload-sarif: true }

  iac:
    permissions: { contents: read, security-events: write }
    uses: alexis1986/security-workflows/.github/workflows/iac.yml@main
    with: { mode: enforce, scan-path: deploy, helm-chart: deploy/chart }

  image-scan:
    needs: [secrets, scan, sast, iac]
    strategy:
      matrix:
        service: [orders, billing]
    permissions: { contents: read, security-events: write, packages: write }
    uses: alexis1986/security-workflows/.github/workflows/image-scan.yml@main
    with:
      mode: enforce
      context: services/${{ matrix.service }}
      image-name: ${{ matrix.service }}
      artifact-name: image-report-${{ matrix.service }}
      push: true
      push-tags: ghcr.io/<owner>/${{ matrix.service }}:sha-${{ github.sha }}
```

A matrix job exposes a single set of `outputs`, so sign each service with its own explicit `sign-sbom` job that depends on the matching image-scan job (or read the digest from the registry in a small job). The `dast` job is identical to the Node example.

## Exceptions

Exceptions live in the consuming repository, never in this one. Every entry needs
a comment with the reason and an expiry date, in this format:

```
# reason — expires YYYY-MM-DD
```

| File | Used by | Example |
|---|---|---|
| `.trivyignore` | `sca.yml`, `iac.yml`, `image-scan.yml` | `# no upgrade path yet — expires 2026-12-31` then `CVE-2021-23337 exp:2026-12-31` |
| `.gitleaksignore` | `secrets.yml` | `# documented example value — expires 2026-12-31` then the finding fingerprint |
| `.semgrepignore` | `sast.yml` | `# generated code — expires 2026-12-31` then `generated/` |
| ZAP rules file | `dast.yml` | `10020<TAB>IGNORE<TAB>(reason — expires 2026-12-31)` |

## Verifying signatures

Verify by digest, never by tag.

Keyless (the identity is the reusable workflow that signed, because GitHub puts
the called workflow in the certificate):

```bash
cosign verify \
  --certificate-identity-regexp '^https://github.com/alexis1986/security-workflows/\.github/workflows/sign-sbom\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-repository <owner>/<repo> \
  ghcr.io/<owner>/my-app@sha256:<digest>

cosign verify-attestation --type cyclonedx \
  --certificate-identity-regexp '^https://github.com/alexis1986/security-workflows/\.github/workflows/sign-sbom\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-repository <owner>/<repo> \
  ghcr.io/<owner>/my-app@sha256:<digest>
```

Key mode:

```bash
cosign verify --key cosign.pub ghcr.io/<owner>/my-app@sha256:<digest>
cosign verify-attestation --key cosign.pub --type cyclonedx ghcr.io/<owner>/my-app@sha256:<digest>
```

If the signature was made with `tlog-upload: false`, add
`--insecure-ignore-tlog=true` to both commands: there is no transparency log
entry to check, so you rely on the key alone. Generate the key pair once with
`cosign generate-key-pair`, store `cosign.key` and its password as repository
secrets, and publish `cosign.pub`.

## Maintenance

Dependabot keeps the pinned GitHub Actions up to date. These pins are not
tracked by Dependabot and must be bumped by hand:

- the Gitleaks image tag and digest (`GITLEAKS_IMAGE` in `secrets.yml`)
- the Trivy image tag and digest (`TRIVY_IMAGE` in `sca.yml`, `iac.yml` and `image-scan.yml`)
- the Helm version used to render charts (`version` of `azure/setup-helm` in `iac.yml`)
- the Semgrep image tag and digest (`SEMGREP_IMAGE` in `sast.yml`)
- the Syft image tag and digest (`SYFT_IMAGE` in `sign-sbom.yml`)
- the cosign release (`cosign-release` of `sigstore/cosign-installer` in `sign-sbom.yml`)
- the ZAP image tag and digest (`ZAP_IMAGE` and `docker_name` in `dast.yml`; keep both equal)
- the actionlint version (`lint.yml`)

`self-test.yml` runs every layer against vulnerable and clean fixtures and tests
the validation, parsing and enforcement scripts, including the failure paths.

## Resumen en español

Workflows reutilizables de GitHub Actions para añadir seguridad a un pipeline de
CI/CD: secretos (Gitleaks), dependencias (Trivy), SAST (Semgrep), IaC e imágenes
(Trivy), SBOM y firma de imágenes (Syft y cosign) y DAST (OWASP ZAP).

- Interfaz comun: `mode` (`report` por defecto, `enforce` falla ante hallazgos
  bloqueantes), `scan-path`, `upload-sarif`, `artifact-name`; salidas
  `blocking-count` y `total-count`.
- Política de bloqueo: cualquier secreto, CRITICAL/HIGH con corrección disponible
  en dependencias e imágenes, severidad ERROR en SAST, CRITICAL/HIGH en IaC,
  alertas High en DAST. La firma no tiene modo `report`.
- Permisos que el llamador debe conceder: `contents: read` siempre;
  `security-events: write` en las capas con SARIF; `packages: write` para subir
  o firmar imágenes en ghcr.io; `id-token: write` para firma sin clave.
- Adopción gradual: empezar en `report`, corregir o justificar excepciones con
  fecha de vencimiento (`# motivo — vence AAAA-MM-DD`) y pasar a `enforce` capa
  por capa.
- La firma se hace siempre por digest. En repositorios privados usar
  `signing: key` con `tlog-upload: false` para no publicar la identidad en el
  registro de transparencia público; la verificación requiere entonces
  `--insecure-ignore-tlog=true`.

## License

MIT
