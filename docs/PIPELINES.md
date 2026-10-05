# Pipelines

sf-preflight is a CLI, so it runs in any pipeline that has Node.js 22.13 or newer and the
repository's history. Each run can produce a Markdown report, JSON, SARIF, JUnit and an
[evidence pack](EVIDENCE.md), and exits with code 2 when the [quality gate](CONFIG.md) fails.

```bash
npx sf-preflight@0 analyze --base origin/main --gate \
  --md-out preflight.md --junit-out preflight.xml --evidence-out evidence.json
```

## DevOps Center

DevOps Center keeps your source in GitHub and moves work through pipeline stages with pull
requests. Run preflight on those pull requests with the [GitHub Action](GITHUB_ACTION.md), and
reviewers see the report on every work item's pull request.

To make the gate block a promotion, make the preflight check **required** on the branches of
your pipeline stages:

1. Add the workflow from [GITHUB_ACTION.md](GITHUB_ACTION.md#quick-start). Run it once so GitHub
   knows the check's name (the job name, `preflight` in the example).
2. In the repository's **Settings → Rules → Rulesets** (or **Branches → Branch protection
   rules**), target the branches your DevOps Center stages merge into, and require the
   `preflight` status check to pass before merging.
3. Try it on a sandbox pipeline first: open a work item whose change fails the gate and confirm
   your DevOps Center setup can't promote it until the check passes. How DevOps Center reports a
   blocked merge depends on its version, so verify the behaviour you rely on.

DevOps Center's built-in testing runs Apex tests, Flow tests and Salesforce Code Analyzer as
quality gates; providers from other tools are partner integrations that aren't open to other
tools yet. preflight complements them: it checks what a change *sets off* across automation,
permissions and agents, and leaves running unit tests to the built-in providers.

## GitLab CI

```yaml
preflight:
  image: node:22
  variables:
    GIT_DEPTH: 0
  script:
    - git fetch origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    - npx --yes sf-preflight@0 analyze --base "origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" --gate
        --md-out preflight.md --junit-out preflight.xml --evidence-out evidence.json
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  artifacts:
    when: always
    reports:
      junit: preflight.xml
    paths: [preflight.md, evidence.json]
```

## Azure Pipelines

```yaml
steps:
  - checkout: self
    fetchDepth: 0
  - task: NodeTool@0
    inputs:
      versionSpec: "22.x"
  - script: |
      npx --yes sf-preflight@0 analyze --base "origin/$(System.PullRequest.TargetBranchName)" --gate \
        --md-out preflight.md --junit-out preflight.xml --evidence-out evidence.json
    displayName: sf-preflight
  - task: PublishTestResults@2
    condition: always()
    inputs:
      testResultsFormat: JUnit
      testResultsFiles: preflight.xml
  - publish: evidence.json
    artifact: sf-preflight-evidence
    condition: always()
```

## Jenkins

```groovy
stage('Preflight') {
  steps {
    sh 'npx --yes sf-preflight@0 analyze --base origin/main --gate --junit-out preflight.xml --evidence-out evidence.json'
  }
  post {
    always {
      junit 'preflight.xml'
      archiveArtifacts artifacts: 'evidence.json'
    }
  }
}
```

## Bitbucket Pipelines

```yaml
pipelines:
  pull-requests:
    "**":
      - step:
          image: node:22
          clone:
            depth: full
          script:
            - mkdir -p test-results
            - npx --yes sf-preflight@0 analyze --base "origin/$BITBUCKET_PR_DESTINATION_BRANCH" --gate
                --junit-out test-results/preflight.xml --evidence-out evidence.json
          artifacts:
            - evidence.json
```

Bitbucket picks up JUnit files under `test-results/` automatically.

## Approvals outside GitHub

The gate's `aiAssistedApprovals` check needs to know who approved the change. Outside the GitHub
Action, write the approving reviewers to a file from your platform's API and pass it with
`--approvals approvals.json` (`["alice", "bob"]`).
