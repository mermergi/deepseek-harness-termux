# startup-prompt

A profile-level bundle that registers `$DSH_HOME/AGENTS.md` — the agent loader's *user-global*
instruction file — as a **system-prompt section** at order 100.

Without it that file still reaches the model, but through `@deepseek-ai/dsh-agent-instructions` as a
user-role `<system-reminder>` attached to the turn: in the trajectory it shows up *after* the first
user message, not inside the initial system prompt. This bundle makes a session **start** with it.

- **Order 100** puts it right after the deployment persona prefix (order 0) and before every
  policy/tool section, which is as early as a profile plugin can go.
- **Text is evaluated per request**, so an edit takes effect on the next request instead of needing a
  new session.
- **Defensive read**: a missing, unreadable, blank or oversized (>64 KB) file degrades to "no
  section" rather than failing prompt composition.

Both delivery paths stay on purpose: the reminder is how a mid-session edit reaches the model, the
section is how a session starts with it. To keep only one, disable the corresponding row in the
profile patch — see the comments in [`cordis.patch.yml`](cordis.patch.yml).

## Install

```sh
node ~/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile web add "$(pwd)/startup-prompt"
```

Then add `@local/dsh-startup-prompt` to the profile's `dsh.profile.bundles` list and restart once.
For a device-local bundle the pnpm route also writes a lockfile entry, which keeps the plugin
manager from dropping the dependency the next time it rewrites `package.json`.
