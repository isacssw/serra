# Agent backends

Serra runs its work on an agent backend. **T3 Code is the default.** You can switch to an agent that speaks the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP) in Settings › Worker › **Agent backend**.

| Agent | What you need |
|---|---|
| Claude Code | `claude` installed and signed in. Serra ships the ACP adapter and runs your `claude`. |
| Codex | `codex` installed and signed in. Serra ships the ACP adapter and runs your `codex`. |
| OpenCode | `opencode` on your PATH (`opencode acp`). |
| Gemini CLI | `gemini` on your PATH (`gemini --acp`). |

Serra installs nothing. Each agent keeps its own login; Serra never reads it. Pick a model per agent next to the
picker, or leave it empty for the agent's own default.

## Adding other ACP harnesses

Any CLI that speaks ACP over stdio (such as Antigravity, Muse, Grok or pi) can be added in two ways — both load live in the installed, running app and are picked up by the running daemon on the next job without a restart:

- **In the app:** open Settings › Worker › **Agent backend**, click **Add ACP agent**, enter a name (e.g. `Antigravity`) and command with arguments (e.g. `agy acp` or `pi --acp`), and submit. Custom agents appear in the **Run on** picker and can be removed from the same card.
- **In the config file:** click **Config file** in the **Agent backend** card (which creates the file if missing and opens it), or edit `~/.local/share/serra/<bot-id>/agent-backend.json` directly:

```json
{
  "backend": "acp",
  "agent": "antigravity",
  "models": {},
  "agents": [
    { "id": "antigravity", "name": "Antigravity", "command": "agy", "args": ["acp"] },
    { "id": "pi", "name": "pi", "command": "pi", "args": ["--acp"], "env": {} }
  ]
}
```

The running app watches `agent-backend.json` and updates the picker as soon as you save. Optional `env` values live only in your own file and are never shown in the UI or logged.

## What runs on it

Everything new: Slack jobs (replies, follow-ups, question cards), app tasks, the knowledge interview, meeting runs and
the weekly review. A job keeps the backend it started on, so switching never moves a job that's going.

## How it differs from T3

- **Where you see a run.** An ACP run has no web link. Jobs › **Transcript** shows its messages, a question it waits
  on with its choices, and a box to reply or answer.
- **Restarts.** The agent runs inside Serra. When Serra restarts, it reopens the run (`session/load`) and the agent
  carries on the turn that was cut off. A question that was waiting is closed; the agent asks again if it still needs to.
- **Steering.** ACP has no way to add to a turn that's going, so a message waits for the turn to end.
- **Worktrees.** Serra makes them itself, in `~/.serra/worktrees/`. Jobs › Clean up only removes T3's for now.

## Images

- **In:** a screenshot sent in Slack is saved in the profile's `attachments/` and its path given to the agent, as on
  T3. An ACP agent that takes images also gets the image itself. One that doesn't gets the path only, and Serra says
  so in the thread.
- **Out:** an image the agent saves and names in its reply is uploaded to the thread, as on T3. An image an ACP agent
  sends inline is saved and uploaded the same way.

## Permissions

Never wider than T3 gives the same kind of run:

- **Jobs, tasks, the interview:** the agent's full-access mode, as a T3 job runs. What it still asks for, and every
  question it asks, waits as a question card in Slack (or in Transcript for an app task).
- **Meeting extraction, Test, the weekly review:** read-only. The agent is put in a mode that asks before any tool,
  Serra refuses every request, and stops the run, as in T3's approval-required mode.
- **A meeting link read:** may use a read, search or fetch tool once per request; anything else is refused.

Serra talks to the agent over stdio and opens no server.

## Files

- `agent-backend.json`: the backend you picked, the model per agent, and agents you added.
- `agent-runs/<session>.json`: each ACP run's transcript, and what a restart needs to carry it on.
