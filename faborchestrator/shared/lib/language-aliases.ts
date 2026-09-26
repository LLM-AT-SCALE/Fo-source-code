// Shared language alias map for syntax highlighting
// Used by code-block.tsx and artifact-preview.tsx

const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  yml: "yaml",
  md: "markdown",
  json: "json",
  html: "markup",
  htm: "markup",
  xml: "markup",
  css: "css",
  scss: "scss",
  sql: "sql",
  go: "go",
  rust: "rust",
  c: "c",
  cpp: "cpp",
  java: "java",
  kotlin: "kotlin",
  swift: "swift",
  php: "php",
  plaintext: "text",
  text: "text",
  csharp: "csharp",
  r: "r",
  lua: "lua",
  toml: "toml",
  ini: "ini",
  yaml: "yaml",
  markdown: "markdown",
  python: "python",
  javascript: "javascript",
  typescript: "typescript",
  bash: "bash",
}

export function normalizeLanguage(language: string): string {
  const lower = language.toLowerCase()
  return LANGUAGE_ALIASES[lower] || lower
}
