# Specs

Specs are managed as code: change them in the same pull request as the behaviour they describe.

| File | Answers |
| --- | --- |
| [high-level.md](high-level.md) | What the product does and why: use cases, grounding rules, edge cases, components, non-functional requirements, open questions. |
| [low-level.md](low-level.md) | How it is built: setup, configuration, data model, tools, workflows, tests, validation record, build order. |

Requirement IDs in the high-level spec (`UC-`, `G-`, `NFR-`) are stable. Reference them in test names and commit messages. If the two files disagree, the high-level spec wins and the low-level spec is corrected.
