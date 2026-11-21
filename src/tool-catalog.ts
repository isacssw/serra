// The tools Serra knows about (SERRA-39): command-line tools it detects, and the services it recommends. Shipped in
// the repo, never fetched, and changed by pull request. Pure data, so the window can import it too.
//
// Serra never installs, signs in or configures any of these. It shows the vendor's own install command and the
// provider's own `mcp add` command for people to copy and run themselves.

/** A brand mark in app/renderer/ui/brand-icons.ts, or a generic icon for brands without one. */
export type ToolIcon = 'github' | 'vercel' | 'atlassian' | 'linear' | 'sentry' | 'docker' | 'googlecloud' | 'flydotio' | 'cloud' | 'terminal';

export interface CliSpec {
  id: string;
  label: string;
  icon: ToolIcon;
  /** The command names to look for, in order (`fly` or `flyctl`). */
  bins: readonly string[];
  versionArgs: readonly string[];
  /**
   * A cheap read-only check: exit 0 means signed in (or, for Docker, running). Omitted when the tool has none Serra
   * trusts not to prompt or rewrite credentials; the row then says "Installed". `account`: read the signed-in account from the output.
   */
  check?: {
    args: readonly string[];
    kind: 'signed-in' | 'running';
    account?: 'first-line' | 'gh';
    needsOutput?: boolean;
    /** A flag added only when the tool's own help lists it (`gh auth status --no-refresh`, in newer gh). */
    ifSupported?: string;
  };
  /** The vendor's install command, for people to copy. Serra never runs it. */
  install: string;
  /** The tool's own sign-in command, for people to copy, when it has one. */
  login?: string;
  docs: string;
}

export const CLI_CATALOG: readonly CliSpec[] = [
  {
    id: 'gh', label: 'GitHub CLI', icon: 'github', bins: ['gh'], versionArgs: ['--version'],
    check: { args: ['auth', 'status', '--active', '--hostname', 'github.com'], kind: 'signed-in', account: 'gh', ifSupported: '--no-refresh' },
    install: 'brew install gh', login: 'gh auth login', docs: 'https://cli.github.com',
  },
  {
    id: 'vercel', label: 'Vercel CLI', icon: 'vercel', bins: ['vercel'], versionArgs: ['--version'],
    install: 'npm i -g vercel', login: 'vercel login', docs: 'https://vercel.com/docs/cli',
  },
  {
    id: 'acli', label: 'Atlassian CLI', icon: 'atlassian', bins: ['acli'], versionArgs: ['--version'],
    check: { args: ['jira', 'auth', 'status'], kind: 'signed-in' },
    install: 'brew tap atlassian/homebrew-acli && brew install acli', docs: 'https://developer.atlassian.com/cloud/acli/guides/install-macos/',
  },
  {
    id: 'sentry-cli', label: 'Sentry CLI', icon: 'sentry', bins: ['sentry-cli'], versionArgs: ['--version'],
    install: 'brew install getsentry/tools/sentry-cli', login: 'sentry-cli login', docs: 'https://docs.sentry.io/cli/installation/',
  },
  {
    id: 'docker', label: 'Docker', icon: 'docker', bins: ['docker'], versionArgs: ['--version'],
    check: { args: ['info', '--format', '{{.ServerVersion}}'], kind: 'running', needsOutput: true },
    install: 'brew install --cask docker', docs: 'https://docs.docker.com/desktop/setup/install/mac-install/',
  },
  {
    id: 'aws', label: 'AWS CLI', icon: 'cloud', bins: ['aws'], versionArgs: ['--version'],
    install: 'brew install awscli', login: 'aws configure sso', docs: 'https://docs.aws.amazon.com/cli/',
  },
  {
    id: 'gcloud', label: 'Google Cloud CLI', icon: 'googlecloud', bins: ['gcloud'], versionArgs: ['--version'],
    check: { args: ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'], kind: 'signed-in', account: 'first-line', needsOutput: true },
    install: 'brew install --cask gcloud-cli', login: 'gcloud auth login', docs: 'https://cloud.google.com/sdk/docs/install',
  },
  {
    id: 'az', label: 'Azure CLI', icon: 'cloud', bins: ['az'], versionArgs: ['--version'],
    check: { args: ['account', 'show', '--query', 'user.name', '--output', 'tsv'], kind: 'signed-in', account: 'first-line', needsOutput: true },
    install: 'brew install azure-cli', login: 'az login', docs: 'https://learn.microsoft.com/cli/azure/install-azure-cli-macos',
  },
  {
    id: 'fly', label: 'Fly.io CLI', icon: 'flydotio', bins: ['fly', 'flyctl'], versionArgs: ['version'],
    install: 'brew install flyctl', login: 'fly auth login', docs: 'https://fly.io/docs/flyctl/install/',
  },
];

/** A remote MCP server people can add in their provider, with the provider's own command. */
export interface McpSuggestion { name: string; url: string; docs: string }

export interface Recommendation {
  id: 'github' | 'sentry' | 'atlassian' | 'linear' | 'vercel';
  label: string;
  icon: ToolIcon;
  /** Recommended for every profile (GitHub), or only when a signal in the repo, knowledge or alert rules says so. */
  always: boolean;
  /** Ready only when its CLI is (GitHub: Serra itself needs `gh`), whatever MCP server there is. */
  needsCli?: boolean;
  /** Why, when `always`. */
  reason?: string;
  /** The CLI from CLI_CATALOG that covers it, if any. */
  cli?: string;
  /** Recognises an MCP server for it by name or host. */
  server: RegExp;
  mcp?: McpSuggestion;
}

export const RECOMMENDATIONS: readonly Recommendation[] = [
  { id: 'github', label: 'GitHub', icon: 'github', always: true, needsCli: true, reason: 'Serra opens pull requests with gh', cli: 'gh', server: /github/i },
  {
    id: 'sentry', label: 'Sentry', icon: 'sentry', always: false, cli: 'sentry-cli', server: /sentry/i,
    mcp: { name: 'sentry', url: 'https://mcp.sentry.dev/mcp', docs: 'https://docs.sentry.io/product/sentry-mcp/' },
  },
  {
    id: 'atlassian', label: 'Atlassian', icon: 'atlassian', always: false, cli: 'acli', server: /atlassian|jira|confluence/i,
    mcp: { name: 'atlassian', url: 'https://mcp.atlassian.com/v1/mcp', docs: 'https://support.atlassian.com/atlassian-rovo-mcp-server/' },
  },
  {
    id: 'linear', label: 'Linear', icon: 'linear', always: false, server: /linear/i,
    mcp: { name: 'linear', url: 'https://mcp.linear.app/mcp', docs: 'https://linear.app/docs/mcp' },
  },
  {
    id: 'vercel', label: 'Vercel', icon: 'vercel', always: false, cli: 'vercel', server: /vercel/i,
    mcp: { name: 'vercel', url: 'https://mcp.vercel.com', docs: 'https://vercel.com/docs/mcp/vercel-mcp' },
  },
];

/** A name as one shell word, quoted when it has spaces or punctuation ("claude.ai Linear"). */
const shellWord = (name: string): string => (/^[\w.:@/+-]+$/.test(name) ? name : `'${name.replace(/'/g, `'\\''`)}'`);

/** Where each provider documents adding an MCP server, and its commands to add a remote one and to sign in. */
export const PROVIDER_MCP = {
  claude: {
    docs: 'https://code.claude.com/docs/en/mcp',
    add: (name: string, url: string) => `claude mcp add --scope user --transport http ${name} ${url}`,
    login: (name: string) => `claude mcp login ${shellWord(name)}`,
  },
  codex: {
    docs: 'https://developers.openai.com/codex/mcp',
    add: (name: string, url: string) => `codex mcp add ${name} --url ${url}`,
    login: (name: string) => `codex mcp login ${shellWord(name)}`,
  },
} as const;
