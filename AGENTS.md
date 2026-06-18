# Repository Instructions

## Response Language

- Always reply to the user in Mandarin Chinese unless the user explicitly asks for another language.
- Keep code, command names, file paths, API names, and error messages in their original language when clarity requires it.

## Global Skill Learning Rule

- After each solved and verified task, run a Skill Reflection step.
- Solve the user's task first. Skill work must not distract from solving or verifying the main issue.
- During Skill Reflection, check whether the task produced reusable, stable, and verified knowledge.
- Reusable knowledge may include debugging workflow, verification checklist, CLI command pattern, code review pattern, architecture decision pattern, UI/UX pattern, error recovery pattern, or domain-specific rule.
- Before creating a new skill, search existing global skills first under `$CODEX_HOME/skills` and any active project skills.
- Update an existing skill when the new knowledge belongs to an existing problem area.
- Create a new global skill only when the knowledge is likely to be reused across projects, the trigger condition is clear, the procedure is repeatable, the verification method is clear, the solution is validated, and the content does not include secrets or private temporary data.
- Prefer project-local skills for project-specific behavior, APIs, architecture, or temporary repository conventions.
- Do not create or update skills for one-time issues, temporary facts, unverified solutions, vague ideas, user preferences unless explicitly requested, secrets, credentials, tokens, or customer data.
- If unsure, propose the skill change first instead of changing an active global skill.
- If a project has its own registry, manifest, or changelog, update it only for project-local skills according to that project's contract.
- Core rule: Update before create. Verify before save. Reuse before invent. Solve first. Reflect after verification.
