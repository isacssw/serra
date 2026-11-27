# Agent backends

Serra runs its work on an agent backend. **T3 Code is the default.** You can switch to an agent that speaks the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP) in Settings › Worker › **Agent**: pick its card, then **Save**.

| Agent | What you need |
|---|---|
| Claude Code | `claude` installed and signed in. Serra ships the ACP adapter and runs your `claude`. |
| Codex | `codex` installed and signed in. Serra ships the ACP adapter and runs your `codex`. |
| OpenCode | `opencode` on your PATH (`opencode acp`). |
| Gemini CLI | `gemini` on your PATH (`gemini --acp`). |

Serra installs nothing. Each agent keeps its own login; Serra never reads it. Pick a model per agent under **Model**,
or leave it empty for the agent's own default. The choice applies to the next job.

## Adding your own ACP agent

Any command that speaks ACP over stdio can be added:

- **In the app:** Settings › Worker › **Agent** › the **Add ACP agent** card: a name and the command with its
  arguments. Serra shows the exact command in a system dialog and saves it only when you confirm.
- **In the file:** **Open agent-backend.json** opens `agent-backend.json` in the profile (`~/.local/share/serra/<bot-id>/`):

```json
{ "agents": [{ "id": "my-agent", "name": "My agent", "command": "my-agent", "args": ["acp"], "env": {} }] }
```

### An agent bound to one app (eve)

Some agents run one app and refuse any other folder: [eve](https://eve.dev)'s `eve acp` must start in the eve app's
folder and opens sessions only there. Give such an agent a `cwd`, an absolute path:

```json
{ "agents": [{ "id": "eve", "name": "eve", "command": "/Users/you/my-agent/node_modules/.bin/eve", "args": ["acp"], "cwd": "/Users/you/my-agent" }] }
```

Serra then starts the agent in that folder and opens every job there instead of a worktree. Since there's no throwaway
worktree, Serra never allows what the agent asks on its own: each approval waits as a card for a person. eve has no
model choice, image input or restart resume over ACP. It also runs one local server per app, and a meeting run or
**Test** starts its own copy of the agent, so those can't run on eve while a job does.

The agent cards update as soon as the file is saved, and an edit to an agent, or its model, applies to the next job
without a restart; a turn already going finishes on the setup it started with. `env` values stay in your file and are
never shown or logged. An agent can't be removed while it has a run going, since the run needs its command to carry on.

## What runs on it

Everything new: Slack jobs (replies, follow-ups, question cards), app tasks, the knowledge interview, meeting runs and
the weekly review. A job keeps the backend it started on, so switching never moves a job that's going.

## How it differs from T3

- **Where you see a run.** An ACP run has no web link. Jobs › **Chat** shows its messages as they stream, its tool calls
  and permissions, its images, a question it waits on with its choices, and a box to reply or answer. A T3 run opens
  there too, with its messages and an **Open in T3** link for the rest.
- **Restarts.** The agent runs inside Serra. When Serra restarts, it reopens the run (`session/load`) and the agent
  carries on the turn that was cut off. A question that was waiting is closed; the agent asks again if it still needs to.
- **Steering.** ACP has no way to add to a turn that's going, so a message waits for the turn to end.
- **Failures.** A turn that fails (the agent needs a sign-in, hit its usage limit, or stopped) shows as **Failed** in
  Jobs › Chat with the reason, and the job waits under **Needs you** until a follow-up runs.
- **Worktrees.** Serra makes them itself, in `~/.serra/worktrees/`. Jobs › Clean up only removes T3's for now.

## Images

- **In:** a screenshot sent in Slack is saved in the profile's `attachments/` and its path given to the agent, as on
  T3. An ACP agent that takes images also gets the image itself. One that doesn't gets the path only, and Serra says
  so in the thread.
- **Out:** an image the agent saves and names in its reply is uploaded to the thread, as on T3. An image an ACP agent
  sends inline is saved and uploaded the same way.
- **Jobs › Chat** shows the same images: from `attachments/`, and from the folders a reply may share images from
  (worktrees, QA runs, temp files). An image elsewhere, such as on the Desktop, shows as its name only.

## Permissions

Never wider than T3 gives the same kind of run:

- **Jobs, tasks, the interview:** the agent's full-access mode, as a T3 job runs. What it still asks for, and every
  question it asks, waits as a question card in Slack (or in Jobs › Chat for an app task).
- **Meeting extraction, Test, the weekly review:** read-only. The agent is put in a mode that asks before any tool,
  Serra refuses every request, and stops the run, as in T3's approval-required mode.
- **A meeting link read:** may use a read, search or fetch tool once per request; anything else is refused.

Serra talks to the agent over stdio and opens no server.

## Files

- `agent-backend.json`: the backend you picked, the model per agent, and agents you added.
- `agent-runs/<session>.json`: each ACP run's transcript, and what a restart needs to carry it on.
