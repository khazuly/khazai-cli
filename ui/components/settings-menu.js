import { createElement as h } from "react";
import { Box, Text, useInput } from "ink";
import { useRef, useState, useCallback } from "react";
import { useTheme } from "../theme.js";
import {
  SETTING_SECTIONS,
  AUTO_FREE_SECTIONS,
  GLOBAL_DEFAULTS,
  resolveEffectiveSettings,
  loadModelSettings,
  saveModelSettings,
  resetModelSettings,
  resolveProviderCapabilities,
  validateSetting,
  settingIsSupported,
  settingIsAutoFreeOnly,
  formatSettingValue,
  suggestedContextLimits,
  isRecommendedValue,
  providerDefaults,
  providerIdFromModel,
} from "../../config/model-settings.js";

const VIEWPORT_SIZE = 6;

// ── Shared SettingRow component ─────────────────────────────────────────

/**
 * A two‑column row for settings labels and values.
 *
 * Props:
 *   marker    – optional selection marker string ("›" or " ")
 *   label     – setting name (Text child)
 *   value     – optional value string to display in the right column
 *   valueColor – colour for the value text (defaults to theme.secondary)
 *   selected  – whether the row is currently selected
 *   dimValue  – whether the value should be dimmed
 */
function SettingRow({ marker, label, value, valueColor, selected, dimValue }) {
  const theme = useTheme();
  return h(Box, { width: "100%" },
    // ── Fixed‑width marker column ───────────────────────────────────
    marker !== undefined
      ? h(Box, { width: 2, flexShrink: 0 },
          h(Text, { color: selected ? theme.primary : theme.text }, marker),
        )
      : null,
    // ── Label column (flexes to fill remaining width) ───────────────
    h(Box, { flexGrow: 1, minWidth: 0 },
      h(Text, {
        color: selected ? theme.primary : theme.text,
        bold: selected,
      }, label),
    ),
    // ── Value column (right‑aligned, no shrink) ─────────────────────
    value !== undefined && value !== null
      ? h(Box, { marginLeft: 2, flexShrink: 0 },
          h(Text, {
            color: valueColor || theme.secondary,
            dimColor: dimValue,
          }, String(value)),
        )
      : null,
  );
}

// ── Helper: clamp index ─────────────────────────────────────────────────

function clampIndex(index, count) {
  if (count === 0) return -1;
  return Math.max(0, Math.min(count - 1, index));
}

// ── Scrolling hook ───────────────────────────────────────────────────────

function useScrollable(items) {
  const [selectedIndex, setSelectedIndex] = useState(items.length ? 0 : -1);
  const [scrollOffset, setScrollOffset] = useState(0);
  const selectedRef = useRef(selectedIndex);
  const scrollRef = useRef(scrollOffset);
  const itemCount = items.length;

  const select = useCallback(requested => {
    const next = clampIndex(requested, itemCount);
    selectedRef.current = next;
    setSelectedIndex(next);
    setScrollOffset(prev => {
      let off = prev;
      if (next < 0) off = 0;
      else if (next < off) off = next;
      if (next >= off + VIEWPORT_SIZE) off = next - VIEWPORT_SIZE + 1;
      return Math.min(off, Math.max(0, itemCount - VIEWPORT_SIZE));
    });
  }, [itemCount]);

  return {
    selectedIndex,
    scrollOffset,
    selectedItem: items[selectedIndex] || null,
    visibleItems: items.slice(scrollOffset, scrollOffset + VIEWPORT_SIZE),
    select,
  };
}

// ── Main settings menu ───────────────────────────────────────────────────

function MainMenu({ model, onOpenSection, onClose }) {
  const theme = useTheme();
  const isAutoFree = String(model).toLowerCase() === "auto-free";

  const sectionIds = isAutoFree
    ? ["generation", "reasoning", "context", "reliability", "tools", "routing", "reset"]
    : ["generation", "reasoning", "context", "reliability", "tools", "reset"];

  const items = sectionIds.map(id => {
    if (id === "reset") return { id, label: "Reset settings" };
    const def = SETTING_SECTIONS[id] || AUTO_FREE_SECTIONS[id];
    return { id, label: def?.label || id };
  });

  const scroll = useScrollable(items);

  useInput((ch, key) => {
    if (key.upArrow) scroll.select(scroll.selectedIndex - 1);
    else if (key.downArrow) scroll.select(scroll.selectedIndex + 1);
    else if (key.pageUp) scroll.select(scroll.selectedIndex - VIEWPORT_SIZE);
    else if (key.pageDown) scroll.select(scroll.selectedIndex + VIEWPORT_SIZE);
    else if (key.home) scroll.select(0);
    else if (key.end) scroll.select(items.length - 1);
    else if (key.return && scroll.selectedItem) {
      onOpenSection(scroll.selectedItem.id);
    } else if (ch === "\u001b" || key.escape) {
      onClose();
    }
  });

  return h(Box, { flexDirection: "column" },
    h(Box, { marginBottom: 1 },
      h(Text, { bold: true, color: theme.primary }, "Model Settings"),
    ),
    h(Box, { flexDirection: "column" },
      // Active model row
      h(Box, { marginBottom: 1 },
        h(SettingRow, {
          label: "Active model",
          value: model,
          valueColor: theme.text,
          selected: false,
        }),
      ),
      ...scroll.visibleItems.map((item, vi) => {
        const idx = scroll.scrollOffset + vi;
        const selected = idx === scroll.selectedIndex;
        return h(SettingRow, {
          key: item.id,
          marker: selected ? "›" : " ",
          label: item.label,
          selected,
        });
      }),
    ),
    items.length > VIEWPORT_SIZE
      ? h(Text, { dimColor: true, color: theme.muted },
          `${scroll.scrollOffset + 1}–${Math.min(scroll.scrollOffset + VIEWPORT_SIZE, items.length)} of ${items.length}`)
      : null,
    h(Text, { dimColor: true, marginTop: 1 },
      "↑↓ Select · Enter Open · Esc Close"),
  );
}

// ── Section settings view ────────────────────────────────────────────────

function SectionView({ model, sectionId, onBack, onEditSetting, onResetSection }) {
  const theme = useTheme();
  const isAutoFree = String(model).toLowerCase() === "auto-free";
  const sectionDef = SETTING_SECTIONS[sectionId] || AUTO_FREE_SECTIONS[sectionId];

  if (!sectionDef) {
    // Reset section - handle inline
    return h(ResetView, { model, sectionId: null, onBack, onResetSection });
  }

  const effective = resolveEffectiveSettings(model);
  const caps = resolveProviderCapabilities(model);

  const items = sectionDef.settings.map(setting => {
    const supported = settingIsSupported(setting.key, model)
      || (isAutoFree && settingIsAutoFreeOnly(setting.key));
    const value = supported ? effective[setting.key] : undefined;
    return { ...setting, supported, value };
  });

  const scroll = useScrollable(items);

  useInput((ch, key) => {
    if (key.upArrow) scroll.select(scroll.selectedIndex - 1);
    else if (key.downArrow) scroll.select(scroll.selectedIndex + 1);
    else if (key.pageUp) scroll.select(scroll.selectedIndex - VIEWPORT_SIZE);
    else if (key.pageDown) scroll.select(scroll.selectedIndex + VIEWPORT_SIZE);
    else if (key.home) scroll.select(0);
    else if (key.end) scroll.select(items.length - 1);
    else if (key.return && scroll.selectedItem) {
      if (scroll.selectedItem.supported) {
        onEditSetting(scroll.selectedItem);
      }
    } else if (ch === "\u001b" || key.escape) {
      onBack();
    }
  });

  return h(Box, { flexDirection: "column" },
    h(Box, { marginBottom: 1 },
      h(Text, { bold: true, color: theme.primary }, sectionDef.label, " Settings"),
    ),
    h(Box, { flexDirection: "column" },
      ...scroll.visibleItems.map((item, vi) => {
        const idx = scroll.scrollOffset + vi;
        const selected = idx === scroll.selectedIndex;
        const displayValue = item.supported
          ? formatSettingValue(item.key, item.value, model)
          : "Not supported";
        const valueColor = item.supported ? theme.secondary : theme.muted;

        return h(SettingRow, {
          key: item.key,
          marker: selected ? "›" : " ",
          label: item.label,
          value: displayValue,
          valueColor,
          selected,
          dimValue: !item.supported,
        });
      }),
    ),
    items.length > VIEWPORT_SIZE
      ? h(Text, { dimColor: true, color: theme.muted },
          `${scroll.scrollOffset + 1}–${Math.min(scroll.scrollOffset + VIEWPORT_SIZE, items.length)} of ${items.length}`)
      : null,
    h(Text, { dimColor: true, marginTop: 1 },
      "↑↓ Select · Enter Edit · Esc Back"),
  );
}

// ── Reset view ───────────────────────────────────────────────────────────

function ResetView({ model, sectionId, onBack, onResetSection, onConfirm, onCancel }) {
  const theme = useTheme();
  const isAutoFree = String(model).toLowerCase() === "auto-free";

  const sectionDef = sectionId
    ? (SETTING_SECTIONS[sectionId] || AUTO_FREE_SECTIONS[sectionId])
    : null;

  const message = sectionDef
    ? `Reset "${sectionDef.label}" settings to provider defaults?`
    : "Reset ALL settings to provider defaults? This cannot be undone.";

  const options = [
    { id: "confirm", label: "Yes, reset", warning: true },
    { id: "cancel", label: "Cancel" },
  ];
  const [selected, setSelected] = useState(0);

  useInput((ch, key) => {
    if (key.upArrow) setSelected(i => (i > 0 ? i - 1 : options.length - 1));
    else if (key.downArrow) setSelected(i => (i < options.length - 1 ? i + 1 : 0));
    else if (key.return) {
      if (options[selected].id === "confirm") {
        onConfirm?.({ sectionId });
        resetModelSettings(model, sectionId || undefined);
        onResetSection?.();
      } else {
        onCancel?.();
      }
    } else if (ch === "\u001b" || key.escape) {
      onCancel?.();
    }
  });

  return h(Box, { flexDirection: "column" },
    h(Box, { marginBottom: 1 },
      h(Text, { color: theme.warning }, "⚠ ", message),
    ),
    ...options.map((opt, i) => {
      const rowSelected = i === selected;
      return h(SettingRow, {
        key: opt.id,
        marker: rowSelected ? "›" : " ",
        label: opt.label,
        selected: rowSelected,
        valueColor: rowSelected
          ? (opt.warning ? theme.error : theme.primary)
          : undefined,
      });
    }),
    h(Text, { dimColor: true, marginTop: 1 },
      "↑↓ Select · Enter Confirm · Esc Cancel"),
  );
}

// ── Value editor ─────────────────────────────────────────────────────────

function ValueEditor({ model, setting, currentValue, onSave, onBack }) {
  const theme = useTheme();
  const caps = resolveProviderCapabilities(model);

  // Build options based on setting type
  const buildOptions = () => {
    const key = setting.key;

    if (key === "contextLimit") {
      const suggestions = suggestedContextLimits();
      return [
        { label: "Provider metadata", value: null },
        ...suggestions.filter(s => s !== null).map(s => ({
          label: s >= 1_000 ? `${(s / 1_000).toLocaleString()}k` : String(s),
          value: s,
        })),
        { label: "Custom value", value: "__custom__" },
      ];
    }

    if (key === "temperature") {
      return [
        { label: "0.0", value: 0 },
        { label: "0.2", value: 0.2 },
        { label: "0.7 (Recommended)", value: 0.7, recommended: true },
        { label: "1.0", value: 1 },
        { label: "Custom value", value: "__custom__" },
        { label: "Provider default", value: "__provider_default__" },
      ];
    }

    if (key === "topP") {
      return [
        { label: "0.0", value: 0 },
        { label: "0.5", value: 0.5 },
        { label: "1.0 (Recommended)", value: 1.0, recommended: true },
        { label: "Custom value", value: "__custom__" },
        { label: "Provider default", value: "__provider_default__" },
      ];
    }

    if (setting.type === "boolean") {
      const boolVal = currentValue !== undefined ? currentValue : GLOBAL_DEFAULTS[key];
      return [
        { label: "On", value: true, active: boolVal === true },
        { label: "Off", value: false, active: boolVal === false },
      ];
    }

    if (setting.type === "select" && setting.options) {
      return setting.options.map(opt => ({
        label: opt.charAt(0).toUpperCase() + opt.slice(1),
        value: opt,
      }));
    }

    // For integer/float types: show current value and custom option
    return [
      { label: `Current: ${formatSettingValue(key, currentValue, model)}`, value: currentValue, info: true },
      { label: "Custom value", value: "__custom__" },
      { label: "Provider default", value: "__provider_default__" },
    ];
  };

  const options = buildOptions();
  const [selected, setSelected] = useState(() => {
    const idx = options.findIndex(o => o.value === currentValue && !o.info);
    return idx >= 0 ? idx : 0;
  });
  const [customInput, setCustomInput] = useState("");
  const [customMode, setCustomMode] = useState(false);
  const [error, setError] = useState("");
  const customInputRef = useRef("");

  useInput((ch, key) => {
    if (customMode) {
      if (key.return) {
        // Submit custom value
        const { valid, value, message } = validateSetting(setting.key, customInputRef.current, model);
        if (!valid) {
          setError(message);
          return;
        }
        setError("");
        onSave(value);
        return;
      }
      if (ch === "\u001b" || key.escape) {
        setCustomMode(false);
        setCustomInput("");
        setError("");
        return;
      }
      if (key.backspace || key.delete || ch === "\x7f" || ch === "\b") {
        customInputRef.current = customInputRef.current.slice(0, -1);
        setCustomInput(customInputRef.current);
        setError("");
        return;
      }
      if (ch && !key.ctrl && !key.meta) {
        customInputRef.current += ch;
        setCustomInput(customInputRef.current);
        setError("");
        return;
      }
      return;
    }

    if (key.upArrow) setSelected(i => Math.max(0, i - 1));
    else if (key.downArrow) setSelected(i => Math.min(options.length - 1, i + 1));
    else if (key.pageUp) setSelected(i => Math.max(0, i - VIEWPORT_SIZE));
    else if (key.pageDown) setSelected(i => Math.min(options.length - 1, i + VIEWPORT_SIZE));
    else if (key.home) setSelected(0);
    else if (key.end) setSelected(options.length - 1);
    else if (key.return) {
      const opt = options[selected];
      if (!opt) return;

      if (opt.value === "__custom__") {
        customInputRef.current = String(currentValue ?? "");
        setCustomInput(customInputRef.current);
        setCustomMode(true);
        setError("");
        return;
      }

      if (opt.value === "__provider_default__") {
        const pv = providerDefaults(providerIdFromModel(model));
        const defaultVal = pv[setting.key] !== undefined ? pv[setting.key] : GLOBAL_DEFAULTS[setting.key];
        onSave(defaultVal);
        return;
      }

      setError("");
      onSave(opt.value);
    } else if (ch === "\u001b" || key.escape) {
      onBack();
    }
  });

  const title = setting.label;

  if (customMode) {
    return h(Box, { flexDirection: "column" },
      h(Box, { marginBottom: 1 },
        h(Text, { bold: true, color: theme.primary }, title),
      ),
      h(Text, { color: theme.muted }, "Enter value:"),
      h(Text, { color: theme.text }, `> ${customInput}${customMode ? "\u258c" : ""}`),
      error ? h(Text, { color: theme.error }, error) : null,
      h(Text, { dimColor: true, marginTop: 1 },
        "Enter Confirm · Esc Back"),
    );
  }

  const currentValStr = formatSettingValue(setting.key, currentValue, model);

  return h(Box, { flexDirection: "column" },
    h(Box, { marginBottom: 1 },
      h(Text, { bold: true, color: theme.primary }, title),
    ),
    h(Text, { color: theme.muted, marginBottom: 1 },
      "Current value: ", h(Text, { color: theme.text }, currentValStr)),
    h(Box, { flexDirection: "column" },
      ...options.map((opt, i) => {
        const isSelected = i === selected;
        return h(SettingRow, {
          key: i,
          marker: isSelected ? "›" : " ",
          label: opt.label,
          selected: isSelected,
          valueColor: isSelected
            ? theme.primary
            : opt.recommended
              ? theme.success
              : undefined,
        });
      }),
    ),
    error ? h(Text, { color: theme.error, marginTop: 1 }, error) : null,
    h(Text, { dimColor: true, marginTop: 1 },
      "↑↓ Select · Enter Confirm · Esc Back"),
  );
}

// ── Main export ──────────────────────────────────────────────────────────

/**
 * SettingsMenu – interactive Ink component for managing model settings.
 *
 * Props:
 *   model          – active model name (e.g. "big-cock")
 *   initialSection – optional section to open directly ("generation", etc.)
 *   onClose        – called when the user closes the menu
 *   onSettingChange – called when a setting changes (key, value)
 */
export function SettingsMenu({ model, initialSection, onClose, onSettingChange }) {
  const isAutoFree = String(model).toLowerCase() === "auto-free";

  // Determine initial view
  const initReset = initialSection === "reset";
  const initSection = initReset || (initialSection && (SETTING_SECTIONS[initialSection] || AUTO_FREE_SECTIONS[initialSection]))
    ? initialSection
    : null;

  const [view, setView] = useState(initReset ? "reset" : initSection ? "section" : "main");
  const [section, setSection] = useState(initReset ? null : initSection);
  const [editing, setEditing] = useState(null);
  const [resetMode, setResetMode] = useState(initReset);
  const [resetSection, setResetSection] = useState(null);

  const handleOpenSection = useCallback(sectionId => {
    if (sectionId === "reset") {
      setResetMode(true);
      setResetSection(null);
      setView("reset");
      return;
    }
    setSection(sectionId);
    setView("section");
  }, []);

  const handleBack = useCallback(() => {
    if (editing) {
      setEditing(null);
      return;
    }
    if (resetMode) {
      setResetMode(false);
      setView("main");
      return;
    }
    setView("main");
    setSection(null);
  }, [editing, resetMode]);

  const handleEditSetting = useCallback(setting => {
    setEditing(setting);
  }, []);

  const handleSave = useCallback(value => {
    if (!editing) return;
    const key = editing.key;
    const settings = { [key]: value };
    saveModelSettings(model, { ...loadModelSettings(model), ...settings });
    onSettingChange?.(key, value);
    setEditing(null);
  }, [editing, model, onSettingChange]);

  const handleResetConfirm = useCallback(() => {
    resetModelSettings(model, resetSection || undefined);
    setResetMode(false);
    setView("main");
    // Notify parent of reset
    onSettingChange?.("__reset__", resetSection || null);
  }, [model, resetSection, onSettingChange]);

  const handleResetCancel = useCallback(() => {
    setResetMode(false);
    setView("main");
  }, []);

  if (editing) {
    const effective = resolveEffectiveSettings(model);
    return h(ValueEditor, {
      model,
      setting: editing,
      currentValue: effective[editing.key],
      onSave: handleSave,
      onBack: handleBack,
    });
  }

  if (resetMode) {
    return h(ResetView, {
      model,
      sectionId: resetSection,
      onBack: handleBack,
      onResetSection: () => {
        setResetMode(false);
        setView("main");
      },
      onConfirm: handleResetConfirm,
      onCancel: handleResetCancel,
    });
  }

  if (view === "section" && section) {
    return h(SectionView, {
      model,
      sectionId: section,
      onBack: handleBack,
      onEditSetting: handleEditSetting,
      onResetSection: () => setView("main"),
    });
  }

  return h(MainMenu, {
    model,
    onOpenSection: handleOpenSection,
    onClose,
  });
}
