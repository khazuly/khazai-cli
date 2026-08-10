import { createElement as h } from "react";
import { Text, Box, useInput, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../theme.js";
import {
  COMMAND_VIEWPORT_SIZE,
  filterCommandItems,
  filterCanonicalCommands,
  findSubCommands,
  useCommandBoundaryKeys,
  useCommandViewport,
} from "./command-viewport.js";
import { resolveCommand } from "../commands.js";
import { CommandDropdown } from "./command-dropdown.js";
import { Panel } from "./surface.js";
import { OptionSelector } from "./option-selector.js";
import { graphemes, insertText, layoutEditableText, moveVertical, printableText, removeBackward } from "./prompt-input-utils.js";
const PASTE_COMPRESSION_THRESHOLD = 160;
export function PromptInput({
  onSubmit,
  inputActive = true,
  commands = [],
  onCommand,
  onClear,
  onAbort,
  activeModel,
  questionOptions = [],
  questionKind = "",
  permissionRequest = null,
  onSelectOption,
  onCancelOption,
  secret = false,
  fileItems = [],
  onPreviewChange,
  onExitSub,
  onToggleAgent,
  canAbort = false,
  question = "",
  questionContext = "",
}) {
  const promptActive = inputActive;
  const { stdout } = useStdout();
  const theme = useTheme();
  const [input, setInput] = useState({ value: "", cursor: 0 });
  const [history, setHistory] = useState([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [optionIdx, setOptionIdx] = useState(0);
  const optionIdxRef = useRef(0);
  const [fileIdx, setFileIdx] = useState(0);
  const [pastePreview, setPastePreview] = useState(null);
  const textBufferRef = useRef("");
  const textTimerRef = useRef(null);
  const pasteStartRef = useRef({ start: null, characterCount: 0, hasPasteChunk: false, timer: null });
  useEffect(() => { optionIdxRef.current = 0; setOptionIdx(0); }, [questionOptions]);
  const subInfo = findSubCommands(commands, input.value);
  const inSubMode = subInfo !== null && input.value.includes(" ");


  let commandResults;
  if (inSubMode) {
    commandResults = filterCommandItems(subInfo.items, input.value, input.value.lastIndexOf(" ") + 1);
  } else {
    commandResults = filterCanonicalCommands(commands, input.value);
  }

  const commandResetKey = [
    input.value,
    activeModel || "",
    commandResults.map(item => item.name).join("\0"),
  ].join("\u0001");
  const commandViewport = useCommandViewport(commandResults, commandResetKey);
  const showCmd = commandResults.length > 0 && input.value.startsWith("/");
  const beforeCursor = graphemes(input.value).slice(0, input.cursor).join("");
  const fileToken = /(?:^|\s)@([^\s]*)$/.exec(beforeCursor);
  const fileQuery = fileToken?.[1]?.toLowerCase() || "";
  const matchedFiles = fileToken
    ? fileItems.filter(path => path.toLowerCase().includes(fileQuery)).slice(0, 8)
    : [];
  const showFiles = matchedFiles.length > 0;
  useCommandBoundaryKeys(
    showCmd && questionOptions.length === 0 && !showFiles,
    commandResults.length - 1,
    commandViewport.selectIndex,
  );
  const prevSelectedRef = useRef(null);
  const prevInSubModeRef = useRef(false);
  const previousSubCommandRef = useRef("");
  useEffect(() => {
    const selected = commandViewport.selectedItem;
    if (prevInSubModeRef.current && !inSubMode) {
      onExitSub?.(previousSubCommandRef.current);
    }
    if (inSubMode) previousSubCommandRef.current = subInfo.cmd.name;
    prevInSubModeRef.current = inSubMode;
    if (inSubMode && selected && onPreviewChange && selected.name !== prevSelectedRef.current) {
      prevSelectedRef.current = selected.name;
      onPreviewChange(subInfo.cmd.name, selected.name);
    }
    if (!inSubMode) prevSelectedRef.current = null;
  }, [commandViewport.selectedIndex, inSubMode, input.value]);
  const selectFile = path => {
    if (!fileToken || !path) return;
    const start = beforeCursor.length - fileToken[1].length;
    const next = `${input.value.slice(0, start)}${path} ${input.value.slice(input.cursor)}`;
    setInput({ value: next, cursor: start + path.length + 1 });
    setFileIdx(0);
  };
  const flushQueuedText = () => {
    if (textTimerRef.current) {
      clearTimeout(textTimerRef.current);
      textTimerRef.current = null;
    }
    const text = textBufferRef.current;
    textBufferRef.current = "";
    if (!text) return "";
    setInput(current => {
      const next = insertText(current, text);
      const characters = graphemes(next.value);
      const characterCount = characters.length;
      const insertionStart = pasteStartRef.current.start ?? current.cursor;
      const compressPaste = !secret && (Boolean(pastePreview)
        || (pasteStartRef.current.hasPasteChunk
          && pasteStartRef.current.characterCount >= PASTE_COMPRESSION_THRESHOLD));
      const start = pastePreview?.start ?? pasteStartRef.current.start ?? graphemes(current.value).length;
      const hiddenLength = Math.max(0, characterCount - start);
      if (pastePreview && insertionStart >= pastePreview.start + pastePreview.hiddenLength) {
        setPastePreview(pastePreview);
      } else if (pastePreview && insertionStart < pastePreview.start) {
        setPastePreview({ ...pastePreview, start: pastePreview.start + graphemes(text).length });
      } else {
        setPastePreview(compressPaste && hiddenLength > 0 ? { start, hiddenLength } : null);
      }
      return next;
    });
    setHistIdx(-1);
    return text;
  };
  const queueText = text => {
    if (textBufferRef.current.length === 0 && pasteStartRef.current.start === null) {
      pasteStartRef.current.start = input.cursor;
      pasteStartRef.current.characterCount = 0;
      pasteStartRef.current.hasPasteChunk = false;
    }
    const textLength = graphemes(text).length;
    pasteStartRef.current.characterCount += textLength;
    pasteStartRef.current.hasPasteChunk ||= textLength >= 16;
    textBufferRef.current += text;
    if (textTimerRef.current) clearTimeout(textTimerRef.current);
    textTimerRef.current = setTimeout(flushQueuedText, 35);
    if (pasteStartRef.current.timer) clearTimeout(pasteStartRef.current.timer);
    pasteStartRef.current.timer = setTimeout(() => {
      pasteStartRef.current.start = null;
      pasteStartRef.current.characterCount = 0;
      pasteStartRef.current.hasPasteChunk = false;
      pasteStartRef.current.timer = null;
    }, 120);
  };
  useEffect(() => () => {
    if (textTimerRef.current) clearTimeout(textTimerRef.current);
    if (pasteStartRef.current.timer) clearTimeout(pasteStartRef.current.timer);
  }, []);
  useInput((ch, key) => {
    if (questionOptions.length > 0) {
      if (key.upArrow) {
        setOptionIdx(index => optionIdxRef.current = index > 0 ? index - 1 : questionOptions.length - 1);
      } else if (key.downArrow) {
        setOptionIdx(index => optionIdxRef.current = index < questionOptions.length - 1 ? index + 1 : 0);
      } else if (key.pageUp) {
        setOptionIdx(index => optionIdxRef.current = Math.max(0, index - COMMAND_VIEWPORT_SIZE));
      } else if (key.pageDown) {
        setOptionIdx(index => optionIdxRef.current = Math.min(questionOptions.length - 1, index + COMMAND_VIEWPORT_SIZE));
      } else if (key.home) {
        optionIdxRef.current = 0;
        setOptionIdx(0);
      } else if (key.end) {
        optionIdxRef.current = questionOptions.length - 1;
        setOptionIdx(questionOptions.length - 1);
      } else if (key.return) {
        onSelectOption?.(questionOptions[optionIdxRef.current]);
      } else if (/^[1-9]$/.test(ch)) {
        const index = Number(ch) - 1;
        if (index < questionOptions.length) onSelectOption?.(questionOptions[index]);
      } else if (ch === "\u001b" || key.escape) {
        onCancelOption?.();
      }
      return;
    }
    if (ch && !key.return && !key.shift && !key.ctrl && !key.meta) {
      const text = printableText(ch);
      if (text) {
        queueText(text);
        return;
      }
    }

    const queuedText = flushQueuedText();
    pasteStartRef.current.start = null;
    pasteStartRef.current.characterCount = 0;
    pasteStartRef.current.hasPasteChunk = false;
    if (pastePreview && (key.backspace || key.delete || ch === "\x7f" || ch === "\b")) {
      setInput(current => {
        const characters = graphemes(current.value);
        const next = [
          ...characters.slice(0, pastePreview.start),
          ...characters.slice(pastePreview.start + pastePreview.hiddenLength),
        ].join("");
        return { value: next, cursor: Math.min(current.cursor, pastePreview.start) };
      });
      setPastePreview(null);
      pasteStartRef.current.start = null;
      pasteStartRef.current.characterCount = 0;
      pasteStartRef.current.hasPasteChunk = false;
      setHistIdx(-1);
      return;
    }

    if (showFiles) {
      if (key.return || key.tab) {
        selectFile(matchedFiles[fileIdx]);
        return;
      }
      if (key.upArrow) {
        setFileIdx(index => index > 0 ? index - 1 : matchedFiles.length - 1);
        return;
      }
      if (key.downArrow) {
        setFileIdx(index => index < matchedFiles.length - 1 ? index + 1 : 0);
        return;
      }
      if (ch === "\u001b" || key.escape) {
        setInput(current => removeBackward(current));
        setFileIdx(0);
        return;
      }
    } else if (showCmd) {
      if (key.return) {
        const sel = commandViewport.selectedItem;
        if (!sel) return;
        if (!inSubMode && sel.sub) {
          if (sel.openSubmenu) {
            const value = `${sel.name} `;
            setInput({ value, cursor: graphemes(value).length });
            commandViewport.resetSelection();
            return;
          }
          onCommand(sel.name, "");
          setInput({ value: "", cursor: 0 });
          commandViewport.resetSelection();
          return;
        }
        if (inSubMode) {
          onCommand(subInfo.cmd.name, sel.name);
        } else {
          onCommand(sel.name, "");
        }
        setInput({ value: "", cursor: 0 });
        setPastePreview(null);
        setHistIdx(-1);
        commandViewport.resetSelection();
        return;
      }
      if (key.upArrow) {
        commandViewport.selectIndex(commandViewport.selectedIndex - 1);
        return;
      }
      if (key.downArrow) {
        commandViewport.selectIndex(commandViewport.selectedIndex + 1);
        return;
      }
      if (key.pageUp) {
        commandViewport.selectIndex(commandViewport.selectedIndex - COMMAND_VIEWPORT_SIZE);
        return;
      }
      if (key.pageDown) {
        commandViewport.selectIndex(commandViewport.selectedIndex + COMMAND_VIEWPORT_SIZE);
        return;
      }
      if (key.home) {
        commandViewport.selectIndex(0);
        return;
      }
      if (key.end) {
        commandViewport.selectIndex(commandResults.length - 1);
        return;
      }
      if (key.tab) {
        const sel = commandViewport.selectedItem;
        if (!sel) return;
        if (inSubMode) {
          const spaceIdx = input.value.lastIndexOf(" ") + 1;
          setInput({ value: input.value.slice(0, spaceIdx) + sel.name + " ", cursor: input.value.slice(0, spaceIdx).length + sel.name.length + 1 });
        } else {
          setInput({ value: sel.name + " ", cursor: sel.name.length + 1 });
        }
        commandViewport.resetSelection();
        return;
      }
      if (ch === "\u001b" || key.escape) {
        setInput({ value: "", cursor: 0 });
        setPastePreview(null);
        commandViewport.resetSelection();
        return;
      }
    }

    if (key.tab && !input.value && !showFiles && !showCmd && !question && !questionKind) {
      onToggleAgent?.();
      return;
    }

    if (key.return) {
      if (key.shift) {
        setInput(current => insertText(current, "\n"));
        setHistIdx(-1);
        return;
      }
      const value = (queuedText ? insertText(input, queuedText).value : input.value).trim();
      if (value) {
        if (value.startsWith("/")) {
          const [command, ...rest] = value.split(/\s+/);

          const resolved = resolveCommand(command);
          const arg = resolved.arg || rest.join(" ");
          onCommand?.(resolved.command, arg);
        } else {
          onSubmit(value);
        }
        setHistory(current => [value, ...current].slice(0, 50));
        setInput({ value: "", cursor: 0 });
        setPastePreview(null);
        setHistIdx(-1);
      }
      return;
    }
    if ((ch === "\u001b" || key.escape) && canAbort) {
      onAbort?.();
      return;
    }

    if (key.backspace || key.delete || ch === "\x7f" || ch === "\b") {
      setInput(removeBackward);
      setHistIdx(-1);
      return;
    }
    if (key.leftArrow) {
      setInput(current => ({ ...current, cursor: Math.max(0, current.cursor - 1) }));
      return;
    }
    if (key.rightArrow) {
      setInput(current => {
        const length = graphemes(current.value).length;
        return { ...current, cursor: Math.min(length, current.cursor + 1) };
      });
      return;
    }
    if (key.upArrow) {
      if (input.value.includes("\n")) {
        setInput(current => moveVertical(current, -1));
        return;
      }
      const index = Math.min(histIdx + 1, history.length - 1);
      if (index >= 0) {
        const value = history[index];
        setHistIdx(index);
        setInput({ value, cursor: graphemes(value).length });
      }
      return;
    }
    if (key.downArrow) {
      if (input.value.includes("\n")) {
        setInput(current => moveVertical(current, 1));
        return;
      }
      if (histIdx > 0) {
        const index = histIdx - 1;
        const value = history[index];
        setHistIdx(index);
        setInput({ value, cursor: graphemes(value).length });
      } else {
        setHistIdx(-1);
        setInput({ value: "", cursor: 0 });
      }
      return;
    }
    if (key.ctrl && ch === "l") {
      onClear?.();
      return;
    }
  }, { isActive: promptActive });

  const terminalWidth = stdout?.columns || 80;
  const panelWidth = Math.max(12, terminalWidth - 1);
  const innerWidth = Math.max(1, panelWidth - 2);
  const inputCharacters = graphemes(input.value);
  const pasteLabel = pastePreview ? `[Pasted ${pastePreview.hiddenLength.toLocaleString()} chars]` : "";
  const visibleInput = secret && input.value
    ? "•".repeat(inputCharacters.length)
    : pastePreview
      ? `${inputCharacters.slice(0, pastePreview.start).join("")}${pasteLabel}${inputCharacters.slice(pastePreview.start + pastePreview.hiddenLength).join("")}`
      : input.value;
  const displayValue = visibleInput || "";
  const displayCursor = pastePreview
    ? input.cursor <= pastePreview.start
      ? input.cursor
      : input.cursor <= pastePreview.start + pastePreview.hiddenLength
        ? pastePreview.start + graphemes(pasteLabel).length
        : input.cursor - pastePreview.hiddenLength + graphemes(pasteLabel).length
    : input.value ? input.cursor : 0;
  const inputRows = layoutEditableText(displayValue, displayCursor, innerWidth);

  if (questionOptions.length > 0) {
    const optionWidth = Math.max(12, terminalWidth - 2);
    return h(OptionSelector, {
      kind: questionKind,
      options: questionOptions,
      permissionRequest,
      question,
      context: questionContext,
      selectedIndex: optionIdx,
      theme,
      width: optionWidth,
    });
  }

  const content = inputRows.map((row, rowIndex) => {
    const cursorOffset = row.cursorOffset;
    const before = cursorOffset === null ? row.cells.join("") : row.cells.slice(0, cursorOffset).join("");
    const cursorCharacter = cursorOffset === null ? "" : row.cells[cursorOffset] || " ";
    const after = cursorOffset === null
      ? ""
      : row.cells.slice(cursorOffset < row.cells.length ? cursorOffset + 1 : cursorOffset).join("");
    const hasInput = input.value !== "";
    return h(Text, {
      key: `input-line-${rowIndex}`,
      color: theme.inputText,
    },
      hasInput ? before : h(Text, { color: theme.inputPlaceholder, dimColor: true }, before),
      cursorOffset === null ? null : `\u001b[5;7m${cursorCharacter}\u001b[25;27m`,
      hasInput ? after : h(Text, { color: theme.inputPlaceholder, dimColor: true }, after),
    );
  });


  const cmdDropdown = showCmd && !showFiles
    ? h(CommandDropdown, {
        commandResults,
        commandViewport,
        inSubMode,
        subInfo,
        activeModel,
        theme,
      })
    : null;
  const fileDropdown = showFiles
    ? h(Box, {
        flexDirection: "column",
        marginLeft: 2,
        marginBottom: 1,
        width: Math.max(20, Math.min(72, terminalWidth - 2)),
      },
        h(Text, { color: theme.metadata }, "Files"),
        ...matchedFiles.map((path, index) => h(Text, {
          key: path,
          color: index === fileIdx ? theme.secondary : theme.toolTarget,
          bold: index === fileIdx,
          wrap: "truncate-end",
        }, index === fileIdx ? "> " : "  ", path)),
      )
    : null;

  return h(Box, { flexDirection: "column", width: "100%" },
    fileDropdown || cmdDropdown,
    question ? h(Text, { color: theme.metadata, bold: true, wrap: "wrap" }, question) : null,
    h(Panel, {
      flexDirection: "column",
      width: panelWidth,
      tone: promptActive ? "primary" : "border",
      paddingX: 0,
    },
      h(Box, {
        flexDirection: "column",
        width: innerWidth,
        backgroundColor: theme.inputBackground,
      },
        h(Box, { flexDirection: "row" },
          h(Text, { color: promptActive ? theme.primary : theme.muted, bold: promptActive }, "❯"),
          h(Text, { color: theme.metadata, dimColor: true, marginLeft: 1 },
            promptActive ? " Ask anything..." : " Input unavailable"),
        ),
        ...content,
      ),
    )
  );
}
