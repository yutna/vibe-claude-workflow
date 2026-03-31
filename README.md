# Claude Workflow

A contract-driven workflow system for Claude Code that enforces structured software engineering phases through hooks, state management, and automated guards.

## What it does

Every task follows six phases, enforced by hooks that run automatically inside Claude Code:

```
Discovery -> Planning -> Implementation -> Quality Gates -> Verification -> Delivery
```

The system prevents common AI-assisted development failures:

- No code changes before requirements are clear
- No implementation before a plan exists
- No delivery before quality gates pass
- No silent architecture or convention changes
- Automatic rollback to the right phase when things go wrong

## Quick start

### New project

```bash
# Clone or copy the workflow into your project
cp -r claude-workflow/.claude your-project/.claude
cp claude-workflow/CLAUDE.md your-project/CLAUDE.md

# Start Claude Code in your project
cd your-project
claude
```

Claude will automatically load the workflow state on session start and enforce phase rules.

### Existing project

```bash
# Copy the workflow infrastructure
cp -r claude-workflow/.claude/hooks your-project/.claude/hooks
cp -r claude-workflow/.claude/commands your-project/.claude/commands
cp -r claude-workflow/.claude/skills your-project/.claude/skills
cp claude-workflow/.claude/settings.json your-project/.claude/settings.json
cp claude-workflow/.claude/workflow-profile.json your-project/.claude/workflow-profile.json
cp claude-workflow/CLAUDE.md your-project/CLAUDE.md

# Merge with your existing .claude/settings.json if you have one
```

Then edit `workflow-profile.json` to match your project's structure (see [Configuration](#configuration)).

## How it works

### Hooks

Four hook points enforce the workflow automatically:

| Hook | When | What it does |
|------|------|-------------|
| `SessionStart` | Session begins | Loads workflow state, shows current phase |
| `PreToolUse` | Before Edit/Write/Bash | Guards edits based on phase (blocks impl before plan, delivery actions before gates pass) |
| `PostToolUse` | After Edit/Write | Tracks touched files, invalidates gates when implementation changes |
| `Stop` | Session ends | Warns about incomplete gates or unrecorded blockers (advisory, never blocks) |

### State machine

The workflow state lives in `.claude/workflow-state.json` and tracks:

```json
{
  "phase": "implementation",
  "taskId": "add-auth",
  "taskSummary": "Add JWT authentication to API",
  "requirements": { "status": "approved", "acceptanceCriteria": [...] },
  "plan": { "status": "approved", "summary": "...", "filesInScope": [...] },
  "implementation": { "status": "in-progress", "filesTouched": [...], "retryCount": 0 },
  "qualityGates": { "typecheck": "pending", "lint": "pending", "tests": "pending", "verification": "pending" },
  "delivery": { "status": "blocked", "userApproved": false }
}
```

**Transition rules:**
- Forward: one phase at a time (no skipping)
- Backward: any distance (for recovery — e.g., delivery back to discovery)
- Requirements must be `clarified` or `approved` before planning
- Plan must be `approved` before implementation
- All gates must be `passed` or `not-applicable` before delivery
- Retry budget: 3 attempts, then work item must be marked `blocked`

### State API

Update state through the CLI (validated against schema and transition rules):

```bash
# Dot-path syntax
node .claude/hooks/scripts/workflow_hook.cjs update-state phase=planning requirements.status=approved

# JSON via stdin
printf '%s' '{"phase":"implementation","implementation":{"status":"in-progress"}}' | \
  node .claude/hooks/scripts/workflow_hook.cjs update-state

# Validate current state
node .claude/hooks/scripts/workflow_hook.cjs validate-state
```

Direct file edits to `workflow-state.json` are allowed during Discovery and Planning, but blocked after that — the API must be used to ensure transition rules are enforced.

## Slash commands

These commands map to workflow phases. Use them inside Claude Code:

| Command | Phase | Description |
|---------|-------|-------------|
| `/discover` | Discovery | Clarify a vague request into scope, constraints, and acceptance criteria |
| `/plan-work` | Planning | Create an implementation plan from clarified requirements |
| `/implement` | Implementation | Execute the approved plan without expanding scope |
| `/review` | Review | Review implemented work for correctness, risk, and readiness |
| `/gates` | Quality Gates | Run all quality gates in canonical order |
| `/deliver` | Delivery | Verify acceptance criteria and prepare delivery summary |
| `/recover` | Recovery | Diagnose a failure, choose rollback phase, and fix deliberately |

## Skills

Skills provide detailed guidance that Claude loads on demand:

| Skill | When triggered |
|-------|----------------|
| `requirements-clarification` | User asks to clarify, scope, or discover |
| `implementation-planning` | User asks to plan or after requirements approved |
| `convention-tiering` | Task changes architecture, naming, or boundaries |
| `quality-gates` | After implementation changes |
| `state-sync` | Phase changes, files touched, gate results change |
| `error-recovery` | Tests, lint, or checks fail |
| `delivery-validation` | After gates pass, before delivery |

## Configuration

### workflow-profile.json

Edit this to match your project:

```json
{
  "repository": {
    "name": "your-project",
    "packageManager": "npm"
  },
  "commands": {
    "typecheck": "npx tsc --noEmit",
    "lint": "npx eslint .",
    "tests": "npm test"
  },
  "roots": {
    "sourceRoots": ["src"],
    "moduleRoots": ["src/features"],
    "testRoots": ["test"]
  }
}
```

### Quality gate commands

Set `commands.typecheck`, `commands.lint`, and `commands.tests` in `workflow-profile.json` to your project's actual commands. Set any to `null` if not applicable — the gate will be recorded as `not-applicable`.

### Convention tiers

Customize the three convention tiers in `workflow-profile.json`:

- **Hard conventions**: Rules that must not drift (phase order, state contract, naming schemes)
- **Strong defaults**: Preferred choices that should be reused unless the plan justifies deviation
- **Local freedom**: Implementation details that can vary without harming consistency

## Extending the workflow

### Adding a new slash command

Create a markdown file in `.claude/commands/`:

```markdown
---
description: What this command does.
argument-hint: "[expected input]"
---

Your prompt instructions here. Reference the workflow phase
this command operates in and which status values it should use.
```

### Adding a new skill

Create a directory in `.claude/skills/` with a `SKILL.md`:

```
.claude/skills/your-skill/SKILL.md
```

```markdown
---
name: your-skill
description: When this skill should be triggered.
---

Detailed procedural guidance for the skill.
Reference correct phase names, status enums, and the state API.
```

### Adding quality gates

To add a new quality gate beyond the built-in four (typecheck, lint, tests, verification):

1. Add the gate to `DEFAULT_STATE.qualityGates` in `workflow_hook.cjs`
2. Add it to the `GATE_STATUSES` validation in `validateState()`
3. Add it to `allGatesGreen()` and `formatGateSummary()`
4. Update the `quality-gates` skill to document the new gate
5. Add tests in `test/workflow_hook.test.cjs`

### Customizing hook behavior

The hook matchers in `.claude/settings.json` control which tools trigger each hook:

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Edit|Write|Bash", "hooks": [...] }],
    "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [...] }]
  }
}
```

Add tool names to the matcher pipe-separated list to extend coverage (e.g., `"Edit|Write|Bash|NotebookEdit"`).

### Adapting CLAUDE.md

`CLAUDE.md` is the contract that Claude follows. When adopting for your project:

1. Keep the phase rules, state contract, and recovery contract as-is
2. Add your project-specific conventions to the "Convention model" section
3. Add your project-specific quality gate commands
4. Adjust the "Definition of done" if your project has additional criteria

## Project structure

```
.claude/
  commands/           # Slash commands (one per phase + recovery)
    discover.md
    plan-work.md
    implement.md
    review.md
    gates.md
    deliver.md
    recover.md
  hooks/
    scripts/
      workflow_hook.cjs   # Core state machine (1,293 lines)
  skills/             # On-demand procedural guidance
    requirements-clarification/
    implementation-planning/
    convention-tiering/
    quality-gates/
    state-sync/
    error-recovery/
    delivery-validation/
  settings.json       # Hook wiring
  settings.local.json # Local overrides (gitignored)
  workflow-profile.json # Project-specific config
  workflow-state.json # Current task state
CLAUDE.md             # Workflow contract
test/
  workflow_hook.test.cjs # 39 unit tests
```

## Running tests

```bash
npm test          # Run all 39 tests
npm run test:watch  # Watch mode
```

## Status values reference

| Field | Valid values |
|-------|-------------|
| `requirements.status` | `needs-clarification`, `clarified`, `approved` |
| `plan.status` | `not-started`, `proposed`, `approved`, `blocked` |
| `implementation.status` | `not-started`, `in-progress`, `completed`, `blocked` |
| `qualityGates.*` | `pending`, `passed`, `failed`, `not-applicable` |
| `delivery.status` | `blocked`, `ready-for-review`, `approved` |

## License

Private.
