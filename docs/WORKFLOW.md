# Repository Workflow

Repository product behavior, architecture, decisions, plans, code, tests, and
runtime signals are the system of record.

## Repository Map

- `AGENTS.md`: entry map and authority boundary.
- `README.md`: repository overview and developer entry point.
- `docs/WORKFLOW.md`: agent workflow and validation rules.
- `docs/architecture/`: architecture documentation entry point and architecture details.
- `docs/patterns/`: invariant-encoding guidance when present.
- `docs/plans/`: durable work records when present and needed.
- `docs/decisions/`: accepted architecture decisions when present.

Use only the repository material that exists and is relevant to the task.
Do not invent missing documentation, commands, policies, or decisions.

## Select The Work Shape

### Does The Work Need Durable Memory?

Use an ephemeral plan for bounded work. Create one plan in `docs/plans/active/`
when work spans sessions, coordinates contributors, has meaningful dependencies,
needs recovery, or cannot safely resume from its diff.

Use `docs/templates/exec-plan.md` only when that template exists. Keep progress
and task-local decisions in the same file; avoid parallel task records without
an independent audience.

### Does The Work Need Human Judgment?

Before editing, identify authority for new externally observable policy. If
materially different choices remain, stop and request the smallest decision.
Configurable defaults are not authority.

Also pause for ambiguous product intent, difficult recovery, weakened
validation, security, compatibility, or insufficient authority.

### What Proves The Behavior?

Use focused tests for local rules, integration tests for boundaries,
end-to-end interaction for user-visible behavior, recovery rehearsal for
dangerous operations, and measurements for reliability or performance.

Plans, checklists, and completion messages do not prove product behavior by
themselves.

## Does The Work Encode An Invariant?

For architecture, reliability, security, or quality boundaries:

1. Find an accepted repository authority that states the required boundary.
   Conventions, code patterns, tests, defaults, and undocumented preferences
   do not establish policy. Stop when authority is absent or materially ambiguous.
2. Reuse the repository's native validation owner and command. Add the smallest
   mechanical check that covers the accepted scope and emits a diagnostic
   naming the violation, rule, and next action.
3. Require positive proof that allowed behavior passes and negative proof that
   the targeted forbidden behavior fails for the intended reason.
4. Report enforcement precisely: a local command is available or passed; a hook
   is optional developer convenience; CI either invokes the check or does not;
   branch protection is externally configured or unverified.

Do not install hooks or change CI, merge, or branch-protection settings unless
separately authorized. When present, use
`docs/patterns/encoding-invariants.md` for the complete method.

## Task Flows

### Read-Only Request

Read only what the answer, review, diagnosis, plan, or status needs. Use
read-only inspection; do not edit files or Harness state. Discovery never
grants authority to fix what it finds.

### Bounded Change

Restate the outcome, inspect its authority, implementation, patterns, and proof,
make the smallest coherent change, run focused and required checks, and report
the outcome, changes, evidence, and limits.

No parallel lifecycle record is required.

### Durable Planned Change

Create or resume one active plan. Keep outcome, context, approach, risk,
recovery, progress, decisions, and validation current. Implement in verifiable
groups, promote lasting decisions, run focused and repository proof, then record
the result and move the plan to `docs/plans/completed/`.

### Operate The Application

When a task requires the real application:

1. Find the consumer-owned runbook and verify prerequisites and ownership.
2. Start only an isolated instance, prove readiness, and create known state.
3. Reproduce through the real interface and inspect correlated runtime evidence.
4. Validate through that interface, then stop only resources this run owns.

If no verified runbook exists, inspect current repository authority and report or
propose the missing guidance. Do not invent commands, credentials, product policy,
or cleanup obligations.

### Improve The Harness

During ordinary work, report reusable agent friction without changing the Harness
for that new purpose. When the user explicitly invokes `$improve-harness`, use the
Harness improvement workflow if it is installed and its referenced template exists.

Do not claim improvement when the rerun did not retrieve or exercise the
intervention.

### Architecture-related work

For work that changes or evaluates system architecture:

1. Identify the affected architecture area.
2. Read `docs/architecture/README.md`.
3. Read only the relevant architecture documents.
4. Check applicable decision records in `docs/decisions/` when they exist.
5. Identify repository authority before making externally observable policy changes.
6. For architecture, reliability, security, or quality invariants, also read
   `docs/patterns/encoding-invariants.md` when it exists.
7. Validate the resulting behavior and report observable evidence.

## Completion Standard

A change is complete when the outcome exists or its blocker is explicit,
repository truth remains current, behavior-appropriate proof passed or its gap
is disclosed, any required plan is current, and the report separates facts,
limits, and unattempted work. Descriptions do not replace observed proof.
