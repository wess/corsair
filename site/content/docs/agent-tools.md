---
title: Tools for agents
description: A Claude Code plugin, a skill, and an MCP server that give an AI agent its Corsair inbox, with install steps for a person or an agent.
section: using
order: 13
short: Tools for agents
eyebrow: Using Corsair
---

# Tools for agents

[Agent email](agents.html) is plain HTTP, so any agent can use it. These make it
one step: a **skill** that teaches the agent the signup flow and its cautions, and
an **MCP server** that gives it tools instead of `curl` commands. Both ship in
one Claude Code plugin, and each also works on its own in any harness.

Everything here needs two values from the control panel's **Agent email** page:

| Variable | Value |
| --- | --- |
| `CORSAIR_URL` | Your server, e.g. `https://mail.example.com` |
| `CORSAIR_AGENT_TOKEN` | The agent's API key, starting `ca_` (shown once). Also its password for IMAP, POP3, SMTP and HTTP Basic auth |

:::note
**If you are an agent reading this,** you probably cannot create the token
yourself — it comes from your user. Ask them to create an agent under **Agent
email** and give you `CORSAIR_URL` and `CORSAIR_AGENT_TOKEN`, then follow the
steps below that fit your harness. Do not install anything the user has not
approved.
:::

## Claude Code: the plugin

Adds the skill and the MCP server together.

```sh
export CORSAIR_URL=https://mail.example.com
export CORSAIR_AGENT_TOKEN=ca_...

claude plugin marketplace add wess/corsair
claude plugin install corsair-agent-email@corsair
```

Or, inside a session: `/plugin marketplace add wess/corsair`, then
`/plugin install corsair-agent-email@corsair`. Start a new session afterwards. The
MCP server reads the two variables from the environment `claude` was started in.

## Any harness: the skill

A skill is one `SKILL.md` file. Put it where your harness looks for skills —
`~/.claude/skills/` for Claude Code, `.agents/skills/` or the equivalent for
others — in a folder named `agent-email`:

```sh
mkdir -p ~/.claude/skills/agent-email
curl -fsSL -o ~/.claude/skills/agent-email/SKILL.md \
  https://raw.githubusercontent.com/wess/corsair/main/plugin/skills/agent-email/SKILL.md
```

It works without the MCP server: it tells the agent the same operations as `curl`
calls against `CORSAIR_URL`.

## Any harness: the MCP server

A single file with no dependencies, run by Node 18 or newer, or Bun.

```sh
mkdir -p ~/.corsair
curl -fsSL -o ~/.corsair/agent-email-mcp.mjs \
  https://raw.githubusercontent.com/wess/corsair/main/plugin/mcp/server.mjs
```

Then register it with your harness. Most take the same JSON:

```json
{
  "mcpServers": {
    "corsair-agent-email": {
      "command": "node",
      "args": ["/home/you/.corsair/agent-email-mcp.mjs"],
      "env": {
        "CORSAIR_URL": "https://mail.example.com",
        "CORSAIR_AGENT_TOKEN": "ca_..."
      }
    }
  }
}
```

Claude Code can do it in one command:

```sh
claude mcp add corsair-agent-email \
  -e CORSAIR_URL=https://mail.example.com \
  -e CORSAIR_AGENT_TOKEN=ca_... \
  -- node ~/.corsair/agent-email-mcp.mjs
```

Read the file before you run it; it is about two hundred lines and talks only to
your own server.

### The tools

| Tool | Does |
| --- | --- |
| `agent_email_address` | The address to sign up with. |
| `wait_for_email` | Waits for a new message, returns it with `links` and `codes`. |
| `list_emails` | Recent mail, newest first. |
| `read_email` | One message in full. |
| `download_attachment` | An attachment, as base64, up to 1 MB. |
| `send_email` | Send or reply, if sending is on for this agent. |

## For models: `llms.txt`

The site publishes [`/llms.txt`](../llms.txt), an index of these docs for a
model, and [`/llms-full.txt`](../llms-full.txt), every page in one file.

## Check it works

Ask the agent for its address, send mail to it from anywhere, then ask it to wait
for the message. If the tools error with "Set CORSAIR_URL and CORSAIR_AGENT_TOKEN",
the harness did not pass the environment through — put the values in the server's
`env` block instead of relying on your shell.
