# Specs

Specs are managed as code. Two rules:

1. **Update the body with the code.** A change to behaviour changes the section of the spec that describes it, in the same pull request. Do not append a note saying how the build differs from the spec: the spec's body is what the system does.
2. **Archive on a significant change of scope.** Before a significant addition or change to the scope, copy the current `high-level.md` and `low-level.md` into `archived/<date>-<name>/` and add a row to [archived/README.md](archived/README.md). The archive is how the original and the final scope are compared.

| File | Answers |
| --- | --- |
| [high-level.md](high-level.md) | What the product does and why: use cases, grounding rules, edge cases, components, non-functional requirements, open questions. |
| [low-level.md](low-level.md) | How it is built: setup, configuration, data model, tools, workflows, tests, validation record, build order. |
| [deployments.md](deployments.md) | The record of every deployment and of the hardening drills. |
| [archived/](archived/) | Earlier versions of the spec, and a list of what changed between the original and what was built. |

Requirement IDs in the high-level spec (`UC-`, `G-`, `NFR-`) are stable. Reference them in test names and commit messages. If the two files disagree, the high-level spec wins and the low-level spec is corrected.
