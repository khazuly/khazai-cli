import { resolve } from "node:path";
import { homedir } from "node:os";

const NO_PATH_COMMANDS = new Set([
  "echo", "printf", "pwd", "true", "false", "date", "export", "set", "unset",
]);
const FILE_OPERAND_COMMANDS = new Set([
  "cat", "head", "tail", "less", "more", "wc", "sort", "uniq", "cut", "paste", "stat",
  "file", "du", "tree", "ls", "rm", "mkdir", "rmdir", "touch", "chmod", "chown", "readlink",
  "realpath", "cp", "mv", "ln", "install", "tee",
]);
const URL_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

function resolveOperand(cwd, value) {
  const source = String(value || "");
  if (source === "~" || source === "$HOME") return homedir();
  if (source.startsWith("~/")) return resolve(homedir(), source.slice(2));
  if (source.startsWith("$HOME/")) return resolve(homedir(), source.slice(6));
  return resolve(cwd, source);
}

export function tokenizeShell(command) {
  const tokens = [];
  let word = "";
  let quote = "";
  let escaped = false;
  const flush = () => {
    if (!word) return;
    tokens.push({ type: "word", value: word });
    word = "";
  };
  const source = String(command || "");
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else word += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    if ("<>".includes(character) || character === "&" && source[index + 1] === ">") {
      let descriptor = "";
      if (/^\d+$/.test(word)) {
        descriptor = word;
        word = "";
      } else {
        flush();
      }
      let operator = character;
      if (source[index + 1] === character || source[index + 1] === "&") operator += source[++index];
      tokens.push({ type: "redirect", value: `${descriptor}${operator}` });
      continue;
    }
    if (";&|()".includes(character)) {
      flush();
      let operator = character;
      if (source[index + 1] === character && ";&|".includes(character)) operator += source[++index];
      tokens.push({ type: "separator", value: operator });
      continue;
    }
    word += character;
  }
  if (escaped) word += "\\";
  flush();
  return { tokens, uncertain: Boolean(quote || escaped) };
}

function optionValue(args, index) {
  const value = args[index];
  const equal = value.indexOf("=");
  if (equal >= 0) return { value: value.slice(equal + 1), next: index };
  return { value: args[index + 1], next: index + 1 };
}

function grepOperands(args) {
  const patterns = [];
  const paths = [];
  let explicitPattern = false;
  let options = true;
  const patternLong = new Set(["--regexp"]);
  const patternOptions = new Set(["--include", "--exclude", "--exclude-dir", "--label"]);
  const valueOptions = new Set(["--after-context", "--before-context", "--context", "--binary-files", "--devices", "--directories", "--max-count"]);
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (options && value === "--") {
      options = false;
      continue;
    }
    const name = value.split("=", 1)[0];
    if (options && patternLong.has(name)) {
      const option = optionValue(args, index);
      if (option.value !== undefined) patterns.push(option.value);
      explicitPattern = true;
      index = option.next;
      continue;
    }
    if (options && patternOptions.has(name)) {
      index = optionValue(args, index).next;
      continue;
    }
    if (options && name === "--file") {
      const option = optionValue(args, index);
      if (option.value !== undefined) paths.push(option.value);
      explicitPattern = true;
      index = option.next;
      continue;
    }
    if (options && value.startsWith("-") && !value.startsWith("--")) {
      const match = /^-([A-Za-z]*?)([efABCmDd])(.+)?$/.exec(value);
      if (match) {
        const optionName = match[2];
        const optionValueText = match[3] || args[++index];
        if (optionName === "e") patterns.push(optionValueText);
        if (optionName === "f") paths.push(optionValueText);
        if (optionName === "e" || optionName === "f") explicitPattern = true;
      }
      continue;
    }
    if (options && value.startsWith("--")) {
      if (valueOptions.has(name)) index = optionValue(args, index).next;
      continue;
    }
    if (!explicitPattern && patterns.length === 0) patterns.push(value);
    else paths.push(value);
  }
  return { patterns, paths };
}

function sedOperands(args) {
  const patterns = [];
  const paths = [];
  let explicitExpression = false;
  let options = true;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (options && value === "--") {
      options = false;
      continue;
    }
    const name = value.split("=", 1)[0];
    if (options && (name === "--expression" || name === "--file")) {
      const option = optionValue(args, index);
      if (name === "--expression") patterns.push(option.value);
      else paths.push(option.value);
      explicitExpression = true;
      index = option.next;
      continue;
    }
    if (options && /^-[ef]/.test(value)) {
      const optionName = value[1];
      const optionValueText = value.slice(2) || args[++index];
      if (optionName === "e") patterns.push(optionValueText);
      else paths.push(optionValueText);
      explicitExpression = true;
      continue;
    }
    if (options && value.startsWith("-")) continue;
    if (!explicitExpression && patterns.length === 0) patterns.push(value);
    else paths.push(value);
  }
  return { patterns, paths };
}

function findOperands(args) {
  const paths = [];
  let index = 0;
  while (index < args.length) {
    const value = args[index];
    if (value === "--") {
      index++;
      continue;
    }
    if (value.startsWith("-") || value === "(" || value === "!") break;
    paths.push(value);
    index++;
  }
  return { patterns: args.slice(index), paths: paths.length ? paths : ["."] };
}

function fileOperands(command, args) {
  const paths = [];
  let options = true;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (options && value === "--") {
      options = false;
      continue;
    }
    if (options && (value === "-t" || value === "--target-directory")) {
      if (args[index + 1] !== undefined) paths.push(args[++index]);
      continue;
    }
    if (options && value.startsWith("--target-directory=")) {
      paths.push(value.slice(value.indexOf("=") + 1));
      continue;
    }
    if (options && value.startsWith("-")) continue;
    paths.push(value);
  }
  if (command === "tee") return { patterns: [], paths };
  return { patterns: [], paths };
}

function nodeOperands(args) {
  let options = true;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (options && value === "--") {
      options = false;
      continue;
    }
    if (options && ["-e", "--eval", "-p", "--print", "-r", "--require"].includes(value)) {
      if (["-r", "--require"].includes(value)) return { patterns: [], paths: [args[index + 1]].filter(Boolean) };
      return { patterns: [args[index + 1]].filter(Boolean), paths: [] };
    }
    if (options && value.startsWith("-")) continue;
    return { patterns: [], paths: [value] };
  }
  return { patterns: [], paths: [] };
}

function workingDirectoryOperands(args, shortName, longName) {
  const paths = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === shortName || value === longName) {
      if (args[index + 1] !== undefined) paths.push(args[++index]);
      continue;
    }
    if (longName && value.startsWith(`${longName}=`)) paths.push(value.slice(value.indexOf("=") + 1));
  }
  return { patterns: args, paths };
}

function unwrapCommand(words) {
  let values = [...words];
  while (values[0] === "env" || values[0] === "command") {
    const wrapper = values.shift();
    if (wrapper === "env") {
      while (values.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(values[0]) || values[0] === "-i")) values.shift();
      if (values[0] === "-u" || values[0] === "--unset") values.splice(0, Math.min(2, values.length));
      while (values[0]?.startsWith("--unset=")) values.shift();
    } else {
      while (["-p", "--"].includes(values[0])) values.shift();
      if (["-v", "-V"].includes(values[0])) return words;
    }
  }
  return values.length ? values : words;
}

function classify(command, args) {
  const name = command.split("/").at(-1);
  if (name === "grep" || name === "egrep" || name === "fgrep" || name === "rg") return { command: name, ...grepOperands(args), uncertain: false };
  if (name === "sed") return { command: name, ...sedOperands(args), uncertain: false };
  if (name === "find") return { command: name, ...findOperands(args), uncertain: false };
  if (name === "cd") return { command: name, patterns: [], paths: args.filter(value => !value.startsWith("-")).slice(0, 1), uncertain: false };
  if (name === "node") return { command: name, ...nodeOperands(args), uncertain: false };
  if (["npm", "pnpm", "yarn", "bun"].includes(name)) return { command: name, ...workingDirectoryOperands(args, "-C", "--prefix"), uncertain: false };
  if (name === "git") return { command: name, ...workingDirectoryOperands(args, "-C", null), uncertain: false };
  if (name === "make") return { command: name, ...workingDirectoryOperands(args, "-C", "--directory"), uncertain: false };
  if (NO_PATH_COMMANDS.has(name)) return { command: name, patterns: args, paths: [], uncertain: false };
  if (FILE_OPERAND_COMMANDS.has(name)) return { command: name, ...fileOperands(name, args), uncertain: false };
  return { command: name, patterns: [], paths: [], uncertain: true };
}

function segmentWords(tokens) {
  const words = [];
  const redirections = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== "redirect") {
      if (token.type === "word") words.push(token.value);
      continue;
    }
    const target = tokens[index + 1];
    if (target?.type !== "word") continue;
    index++;
    if (!token.value.endsWith(">&") && !token.value.endsWith("<&") && !token.value.includes("<<")) {
      redirections.push(target.value);
    }
  }
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  return { words, redirections };
}

export function parseShellCommand(command, initialWorkingDirectory) {
  const tokenized = tokenizeShell(command);
  const commands = [];
  const filesystemTargets = [];
  const uncertainCommands = [];
  const directoryStack = [];
  let cwd = resolve(initialWorkingDirectory);
  let segment = [];
  const finish = separator => {
    if (!segment.length) return;
    const { words, redirections } = segmentWords(segment);
    segment = [];
    if (!words.length) return;
    const commandWords = unwrapCommand(words);
    const classified = classify(commandWords[0], commandWords.slice(1));
    const operandPaths = classified.paths
      .filter(value => value && !URL_PATTERN.test(value))
      .map(value => resolveOperand(cwd, value));
    const redirectionTargets = redirections
      .filter(value => value && !URL_PATTERN.test(value))
      .map(value => resolveOperand(cwd, value));
    const paths = [...operandPaths, ...redirectionTargets];
    commands.push({ ...classified, workingDirectory: cwd, paths, redirections, redirectionTargets });
    filesystemTargets.push(...paths);
    if (classified.uncertain) uncertainCommands.push(classified.command);
    if (classified.command === "cd" && paths[0] && separator !== "|") cwd = paths[0];
  };
  for (const token of tokenized.tokens) {
    if (token.type !== "separator") {
      segment.push(token);
      continue;
    }
    finish(token.value);
    if (token.value === "(") directoryStack.push(cwd);
    if (token.value === ")" && directoryStack.length) cwd = directoryStack.pop();
  }
  finish("");
  return {
    commands,
    workingDirectory: resolve(initialWorkingDirectory),
    filesystemTargets: [...new Set(filesystemTargets)],
    uncertain: tokenized.uncertain || uncertainCommands.length > 0,
    reason: tokenized.uncertain
      ? "The shell command could not be parsed completely."
      : uncertainCommands.length
        ? `Unclassified command: ${uncertainCommands.join(", ")}`
        : "Filesystem operands were classified from parsed shell commands.",
  };
}
